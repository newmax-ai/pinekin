# Windows SQLite 只读组件

`sqlite-reader.c` 由 `scripts/build-sqlite-reader.mjs` 编译。生产只在 Windows 使用；macOS 保持系统沙箱 sqlite3，另编译 Unix 分支供合成协议回归。

## 固定上游

- SQLite 3.54.1 官方 amalgamation：`https://www.sqlite.org/2026/sqlite-amalgamation-3540100.zip`
- ZIP SHA-256：`0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9`
- 编译 `sqlite3.c` 与 `shell.c` 中原样提取的 `ext/misc/shathree.c`。后者仅补回 amalgamation 合并时去掉的头文件和 `u64` typedef；保留上游版权声明。SQLite 上游源码声明属于 public domain。
- 不编译 shell；`SQLITE_OMIT_LOAD_EXTENSION`、内存临时存储、禁用数据库 mmap，保留 WAL 所需只读 SHM 映射。
- 下载、解压、构建分别位于 `node_modules/.cache/pinekin-sqlite/` 下独立目录。脚本不从下载／源码目录执行。来源与二进制指纹变化会重新构建，不在运行时联网获取组件。

## 文件安全边界

Windows VFS 系统调用覆盖必须全部安装成功，否则退出：

1. 数据库与 WAL 的 VFS 打开请求收紧为 `SQLITE_OPEN_READONLY`，允许列表只含这次授权的 DB／WAL／SHM。
2. `CreateFileW` 仅接受 `GENERIC_READ`；原生调用一律使用 `OPEN_EXISTING`，绝不透传 `OPEN_ALWAYS` 的创建语义。拒绝删除时关闭，打开时使用 `FILE_FLAG_OPEN_REPARSE_POINT`，句柄不共享删除权限。
3. 核对句柄最终路径与请求路径，拒绝重解析文件与目录、UNC、设备路径和网络驱动器。
4. `CreateFileMappingW` 只允许 `PAGE_READONLY`；不返回可写映射。`WriteFile`、`SetEndOfFile`、`DeleteFileW` 及 VFS 删除一律拒绝。
5. 仍使用上游 Windows WAL 共享锁、DMS 锁与事务，不自己实现 WAL 格式或锁协议。
6. `readonly_shm=1` 使用现有 SHM。需要新建、初始化或恢复副文件的情况失败，不用忽略 WAL 或复制整库兜底。

这不是通用 OS 进程沙箱：防护针对 SQLite 的文件访问与 SQL 投影，不承诺抵御 SQLite/C 内存安全漏洞、恶意管理员替换安装文件或被接管的宿主。主进程路径及身份检查、固定 SQL、字段校验、30 秒超时和 64 MiB 输出预算仍须保留。

## SQL 协议

参数是已授权的规范路径与父进程构造的只读 URI；stdin 仅为父进程生成的 SQL（1 MiB 上限）。组件不读取 rc、不支持点命令或任意扩展。先固定安全 PRAGMA，再安装 authorizer：拒绝非白名单表、写入、ATTACH 和不安全 PRAGMA；来源 ID 不会作为 SQL 代码。SHA3 使用上游 `sha3_query`，在同一事务中计算所选会话完整文本投影摘要。

`sqlite3_exec` 首错即停。stdout 仅输出单列记录，stderr 输出错误；失败退出时父进程丢弃全部投影。固定协议自检为 `pinekin-readonly-v1 SQLite 3.54.1`。

## 构建与验证

```sh
npm run build:sqlite-reader
npm test -- tests/windows-sqlite-helper.test.ts tests/windows-source-sqlite.test.ts tests/sqlite-reader-packaging.test.ts
```

Windows 需要 x64 Visual Studio C++ Build Tools（脚本用 `vswhere` 定位，不假设已启动 Developer Prompt），macOS 合成测试需要 Command Line Tools。Windows 批处理使用 UTF-8 代码页，保留 cmd 专用引号规则。输出位于 `resources/native/<platform>-<arch>/`，不进 git；NSIS 把 Windows 可执行文件放在 asar 外的 `resources/native/`。

Windows 当前仅 x64；不通过交叉生成或模拟平台标志冒充原生验证。用例使用合成库，验证读取活跃 WAL、未提交不可见、副文件不变、SHM 缺失失败、授权表保护与命令失败。Windows junction 测试必须在 Windows 执行。macOS 上同构协议通过，只证明该分支和固定 SQL，不证明 Win32 分支已通过。
