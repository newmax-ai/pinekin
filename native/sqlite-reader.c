/* Pinekin 固定投影读取器。SQLite 的只读标志不是文件系统安全边界：
 * Windows VFS 的每个文件句柄只准 GENERIC_READ / OPEN_EXISTING，映射只准 PAGE_READONLY。
 * 保留 SQLite 原生 WAL 事务、共享内存锁和 busy 行为，不复制整库，不恢复日志。
 * Unix 分支仅用于相同协议的合成回归；生产 macOS 仍走 sandbox-exec。 */
#include "sqlite3.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#include <io.h>
#include <fcntl.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <limits.h>
#endif

int sqlite3_shathree_init(sqlite3 *, char **, const sqlite3_api_routines *);
static const char *allowed_path;
static sqlite3_vfs guarded_vfs;
static sqlite3_vfs *base_vfs;

#ifdef _WIN32
static int matches_wide(const wchar_t *path);
static void normalize_slashes(wchar_t *p) { for (; *p; p++) if (*p == L'/') *p = L'\\'; }
#endif
static int matches(const char *path) {
#ifdef _WIN32
  wchar_t wide[32768];
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide, 32768)) return 0;
  normalize_slashes(wide);
  return matches_wide(wide);
#else
  size_t n = strlen(allowed_path);
  return !strcmp(path, allowed_path) ||
    (!strncmp(path, allowed_path, n) && (!strcmp(path+n, "-wal") || !strcmp(path+n, "-shm")));
#endif
}
static int deny_delete(sqlite3_vfs *v, const char *path, int sync_dir) {
  (void)v; (void)path; (void)sync_dir;
  return SQLITE_READONLY;
}
/* 避免 URI 中指定别的 VFS 绕过系统调用守卫；父进程只发固定生成的 URI。 */
static int guarded_open(sqlite3_vfs *v, const char *path, sqlite3_file *file, int flags, int *out) {
  (void)v;
  if (!path || !matches(path) || (flags & SQLITE_OPEN_DELETEONCLOSE) ||
      !(flags & (SQLITE_OPEN_MAIN_DB | SQLITE_OPEN_WAL))) return SQLITE_CANTOPEN;
  /* SQLite 会先以 RW|CREATE 请求 WAL；收紧为只读并通过 out 返回实际权限。 */
  flags = (flags & ~(SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)) | SQLITE_OPEN_READONLY;
  return base_vfs->xOpen(base_vfs, path, file, flags, out);
}

#ifdef _WIN32
static wchar_t allowed_wide[32768];
static const wchar_t *without_prefix(const wchar_t *p) {
  return wcsncmp(p, L"\\\\?\\", 4) == 0 ? p+4 : p;
}
static int matches_wide(const wchar_t *path) {
  const wchar_t *p = without_prefix(path), *a = without_prefix(allowed_wide);
  size_t n = wcslen(a);
  return !_wcsicmp(p, a) || (!_wcsnicmp(p, a, n) &&
    (!_wcsicmp(p+n, L"-wal") || !_wcsicmp(p+n, L"-shm")));
}
static HANDLE WINAPI read_only_open(LPCWSTR path, DWORD access, DWORD share,
    LPSECURITY_ATTRIBUTES security, DWORD disposition, DWORD flags, HANDLE template_file) {
  wchar_t actual[32768], normalized[32768];
  BY_HANDLE_FILE_INFORMATION info;
  DWORD length;
  HANDLE h;
  (void)security; (void)template_file;
  if (!path || wcslen(path) >= 32768) { SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE; }
  wcscpy(normalized, path); normalize_slashes(normalized); path = normalized;
  if (!matches_wide(path) || access != GENERIC_READ ||
      (disposition != OPEN_EXISTING && disposition != OPEN_ALWAYS) || (flags & FILE_FLAG_DELETE_ON_CLOSE)) {
    SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE;
  }
  /* SQLite 的只读 SHM 仍请求 OPEN_ALWAYS；在 OS 调用前收紧，绝不创建副文件。 */
  h = CreateFileW(path, GENERIC_READ, share & ~FILE_SHARE_DELETE, NULL,
    OPEN_EXISTING, flags | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (h == INVALID_HANDLE_VALUE) return h;
  length = GetFinalPathNameByHandleW(h, actual, 32768, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (!GetFileInformationByHandle(h, &info) ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) ||
      !length || length >= 32768 || _wcsicmp(without_prefix(path), without_prefix(actual))) {
    CloseHandle(h); SetLastError(ERROR_ACCESS_DENIED); return INVALID_HANDLE_VALUE;
  }
  return h;
}
static HANDLE WINAPI read_only_mapping(HANDLE file, LPSECURITY_ATTRIBUTES security, DWORD protect,
    DWORD high, DWORD low, LPCWSTR name) {
  if (file == INVALID_HANDLE_VALUE || protect != PAGE_READONLY || name) {
    SetLastError(ERROR_ACCESS_DENIED); return NULL;
  }
  return CreateFileMappingW(file, security, PAGE_READONLY, high, low, NULL);
}
static BOOL WINAPI deny_write(HANDLE h, LPCVOID b, DWORD n, LPDWORD written, LPOVERLAPPED o) {
  (void)h; (void)b; (void)n; (void)o;
  if (written) *written = 0;
  SetLastError(ERROR_ACCESS_DENIED); return FALSE;
}
static BOOL WINAPI deny_truncate(HANDLE h) {
  (void)h; SetLastError(ERROR_ACCESS_DENIED); return FALSE;
}
static BOOL WINAPI deny_unlink(LPCWSTR p) {
  (void)p; SetLastError(ERROR_ACCESS_DENIED); return FALSE;
}
static int install_system_guards(void) {
  const wchar_t *p;
  wchar_t drive[4];
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, allowed_path, -1, allowed_wide, 32768)) return 0;
  normalize_slashes(allowed_wide);
  p = without_prefix(allowed_wide);
  /* 不连接 UNC、设备路径或映射网络盘；Windows 本地盘长路径仍可用。 */
  if (!((p[0]>=L'A' && p[0]<=L'Z') || (p[0]>=L'a' && p[0]<=L'z')) || p[1]!=L':' || p[2]!=L'\\') return 0;
  drive[0]=p[0]; drive[1]=L':'; drive[2]=L'\\'; drive[3]=0;
  if (GetDriveTypeW(drive) != DRIVE_FIXED && GetDriveTypeW(drive) != DRIVE_REMOVABLE) return 0;
  return base_vfs->xSetSystemCall(base_vfs, "CreateFileW", (sqlite3_syscall_ptr)read_only_open)==SQLITE_OK &&
    base_vfs->xSetSystemCall(base_vfs, "CreateFileMappingW", (sqlite3_syscall_ptr)read_only_mapping)==SQLITE_OK &&
    base_vfs->xSetSystemCall(base_vfs, "WriteFile", (sqlite3_syscall_ptr)deny_write)==SQLITE_OK &&
    base_vfs->xSetSystemCall(base_vfs, "SetEndOfFile", (sqlite3_syscall_ptr)deny_truncate)==SQLITE_OK &&
    base_vfs->xSetSystemCall(base_vfs, "DeleteFileW", (sqlite3_syscall_ptr)deny_unlink)==SQLITE_OK;
}
#else
static int read_only_open(const char *path, int flags, ...) {
  char actual[PATH_MAX];
  struct stat before, held;
  int fd;
  if (!path || !matches(path) || (flags & O_ACCMODE) != O_RDONLY ||
      (flags & (O_CREAT | O_TRUNC | O_APPEND)) || !realpath(path, actual) ||
      strcmp(actual, path) || lstat(path, &before) || !S_ISREG(before.st_mode)) {
    errno = EACCES; return -1;
  }
  fd = open(path, flags | O_NOFOLLOW | O_NONBLOCK);
  if (fd >= 0 && (fstat(fd, &held) || held.st_dev != before.st_dev || held.st_ino != before.st_ino)) {
    close(fd); errno = EACCES; return -1;
  }
  return fd;
}
static int deny_unlink(const char *p) { (void)p; errno = EACCES; return -1; }
static int install_system_guards(void) {
  return base_vfs->xSetSystemCall(base_vfs, "open", (sqlite3_syscall_ptr)read_only_open)==SQLITE_OK &&
    base_vfs->xSetSystemCall(base_vfs, "unlink", (sqlite3_syscall_ptr)deny_unlink)==SQLITE_OK;
}
#endif

static int authorize(void *context, int action, const char *a, const char *b, const char *db, const char *trigger) {
  (void)context; (void)trigger;
  switch (action) {
    case SQLITE_SELECT: case SQLITE_RECURSIVE: return SQLITE_OK;
    case SQLITE_TRANSACTION:
      return a && (!strcmp(a,"BEGIN") || !strcmp(a,"COMMIT") || !strcmp(a,"ROLLBACK")) ? SQLITE_OK : SQLITE_DENY;
    case SQLITE_READ:
      if (!a || (db && strcmp(db,"main"))) return SQLITE_DENY;
      return !strcmp(a,"conversations") || !strcmp(a,"sessions") || !strcmp(a,"messages") ||
        !strcmp(a,"orca_workers") || !strcmp(a,"orca_teams") || !strcmp(a,"sqlite_master") ||
        !strcmp(a,"sqlite_schema") || !strcmp(a,"pragma_table_list") || !strcmp(a,"pragma_table_info") ? SQLITE_OK : SQLITE_DENY;
    case SQLITE_PRAGMA:
      return a && (!strcmp(a,"table_list") || !strcmp(a,"table_info")) ? SQLITE_OK : SQLITE_DENY;
    case SQLITE_FUNCTION:
      /* 仅编译 SQLite 核心与官方 SHA3 扩展；仍显式拒绝有外部副作用的函数。 */
      return b && strcmp(b,"load_extension") && strcmp(b,"readfile") && strcmp(b,"writefile") ? SQLITE_OK : SQLITE_DENY;
    default: return SQLITE_DENY;
  }
}
static int print_row(void *context, int n, char **values, char **names) {
  (void)context; (void)names;
  if (n != 1 || !values[0]) return 1;
  return puts(values[0]) < 0;
}
static int run(int argc, char **argv) {
  sqlite3 *db = NULL;
  char *error = NULL, *sql;
  size_t n;
  int rc;
  if (argc == 2 && !strcmp(argv[1],"--version")) { puts("pinekin-readonly-v1 SQLite " SQLITE_VERSION); return 0; }
  if (argc != 3 || strlen(argv[1]) > 65535 || strlen(argv[2]) > 262144) { fputs("invalid reader arguments\n",stderr); return 1; }
  allowed_path = argv[1];
  sqlite3_hard_heap_limit64(256 * 1024 * 1024);
  if (sqlite3_initialize()!=SQLITE_OK) return 1;
  base_vfs = sqlite3_vfs_find(NULL);
  if (!base_vfs || base_vfs->iVersion < 3 || !install_system_guards()) {
    fputs("read-only VFS unavailable\n",stderr); return 1;
  }
  guarded_vfs = *base_vfs;
  guarded_vfs.zName = "pinekin-readonly";
  guarded_vfs.xOpen = guarded_open;
  guarded_vfs.xDelete = deny_delete;
  if (sqlite3_vfs_register(&guarded_vfs, 1)!=SQLITE_OK) return 1;
  rc = sqlite3_open_v2(argv[2], &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_NOMUTEX, "pinekin-readonly");
  if (rc != SQLITE_OK) goto failed;
  sqlite3_extended_result_codes(db, 1);
  sqlite3_busy_timeout(db, 2000);
  sqlite3_limit(db, SQLITE_LIMIT_LENGTH, 64 * 1024 * 1024);
  sqlite3_limit(db, SQLITE_LIMIT_SQL_LENGTH, 1024 * 1024);
  sqlite3_db_config(db, SQLITE_DBCONFIG_DEFENSIVE, 1, NULL);
  sqlite3_db_config(db, SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0, NULL);
  rc = sqlite3_exec(db, "PRAGMA temp_store=MEMORY; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;", NULL, NULL, &error);
  if (rc != SQLITE_OK) goto failed;
  rc = sqlite3_shathree_init(db, &error, NULL);
  if (rc != SQLITE_OK) goto failed;
  sqlite3_set_authorizer(db, authorize, NULL);
  sql = malloc(1024 * 1024 + 1);
  if (!sql) { rc=SQLITE_NOMEM; goto failed; }
  n = fread(sql, 1, 1024 * 1024, stdin);
  if (ferror(stdin) || !feof(stdin) || memchr(sql, 0, n)) {
    free(sql); fputs("invalid SQL input budget\n",stderr); sqlite3_close(db); return 1;
  }
  sql[n] = 0;
  /* sqlite3_exec 首错即停；不使用 CLI 点命令，不读用户 rc，不允许 ATTACH/写入。 */
  rc = sqlite3_exec(db, sql, print_row, NULL, &error);
  free(sql);
  if (rc != SQLITE_OK) goto failed;
  sqlite3_close(db);
  return fflush(stdout) ? 1 : 0;
failed:
  fprintf(stderr,"SQLite readonly error %d: %s\n",rc,error ? error : db ? sqlite3_errmsg(db) : "unavailable");
  sqlite3_free(error);
  if (db) sqlite3_close(db);
  return 1;
}
#ifdef _WIN32
int wmain(int argc, wchar_t **wide) {
  char **argv = calloc((size_t)argc, sizeof(char*));
  int i, rc;
  if (!argv) return 1;
  _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
  for (i=0; i<argc; i++) {
    int size=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide[i],-1,NULL,0,NULL,NULL);
    if (!size || !(argv[i]=malloc((size_t)size)) || !WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide[i],-1,argv[i],size,NULL,NULL)) return 1;
  }
  rc=run(argc,argv);
  for(i=0;i<argc;i++) free(argv[i]);
  free(argv);
  return rc;
}
#else
int main(int argc, char **argv) { return run(argc,argv); }
#endif
