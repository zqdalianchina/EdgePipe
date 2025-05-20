# EdgePipe
这段 Cloudflare Workers 代码是一个实现了 VLESS over WebSocket + TLS 协议的代理服务器。它的主要目的是提供一种隐蔽、抗封锁的代理方式，利用 Cloudflare 的全球网络基础设施进行流量转发，并可选地通过一个 SOCKS5 代理进行进一步的路由。它提供了一个方便的配置链接生成功能，简化客户端设置。
