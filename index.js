// dsh-pip-window —— Host 半边（Node 侧）。
//
// 数据面完全在客户端半：它直接注入官方的 ctx.sessions 服务读会话、发消息，
// 因此这里既不需要注册 HTTP 端点，也不需要把会话事件桥接过来。
// 保留 Host 半只是让插件有一个可加载的宿主入口，并在激活时留一条日志。
//
// 零构建：直接是 ESM 源码，由 profile 的 loader 原样 import。

const TAG = '[dsh-pip-window]'

export function apply(ctx) {
  console.log(TAG, 'host half loaded — apply() called')

  // 可选注入：没有 webServer 的部署（headless / acp）里插件照常激活。
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      console.log(TAG, 'host half effect mounted')
      return () => console.log(TAG, 'host half effect disposed')
    }, 'dsh-pip-window: host half effect')
  })
}
