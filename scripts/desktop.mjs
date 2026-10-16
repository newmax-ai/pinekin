// 从其他 Electron 客户端的终端启动时，不继承它的二进制或页面入口。
for (const key of ['ELECTRON_EXEC_PATH', 'ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE']) {
  delete process.env[key]
}
const { createServer, preview } = await import('electron-vite')
if (process.argv[2] === 'dev') await createServer(undefined, {})
else if (process.argv[2] === 'preview') await preview(undefined, { skipBuild: true })
else throw new Error('使用 dev 或 preview 启动模式')
