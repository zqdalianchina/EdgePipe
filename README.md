# EdgePipe
这段 Cloudflare Workers 代码是一个实现了 VLESS over WebSocket + TLS 协议的代理服务器。它的主要目的是提供一种隐蔽、抗封锁的代理方式，利用 Cloudflare 的全球网络基础设施进行流量转发，并可选地通过一个 SOCKS5 代理进行进一步的路由。它提供了一个方便的配置链接生成功能，简化客户端设置。

这个代码主要用于：

1.  **搭建 VLESS over WebSocket + TLS 代理:** 这是最直接的功能。用户可以在 Cloudflare Workers 上部署这个代码，并配置 UUID 和域名。然后使用支持 VLESS + WS + TLS 的客户端软件（如 V2Ray, Xray, sing-box, Clash 等），使用 Workers 的域名、配置的 UUID 和 `/` 路径来连接，从而通过 Cloudflare 的边缘网络进行代理访问。
2.  **绕过网络限制:** VLESS + WS + TLS 的组合流量在外表上类似于标准的 HTTPS 流量，不容易被网络防火墙识别和干扰。将其部署在 Cloudflare Workers 上，利用 Cloudflare 大量合法的 IP 地址，可以进一步提高隐蔽性，帮助用户访问受限制的网络资源。
3.  **隐藏源站 IP:** 由于流量先到达 Cloudflare 的边缘节点，然后从 Cloudflare 的网络转发出去，实际的 Workers 后端没有固定的公网 IP，用户的连接看起来是到 Cloudflare 的某个 IP，而不是到具体的代理服务器 IP。
4.  **利用 SOCKS5 代理链 (可选):** 通过配置 SOCKS5 环境变量，可以将 Cloudflare Worker 作为一个前置代理，将流量转发到另一个 SOCKS5 代理服务器，再由 SOCKS5 服务器转发到最终目标。这可以用于访问特定地理位置资源，或增加另一层代理来进一步隐藏真实目的地。

**详细功能：**

1.  **Cloudflare Workers 环境:** 代码是为 Cloudflare Workers 设计的，利用了 Cloudflare 的 `fetch` API 来处理 HTTP/WebSocket 请求，以及 `cloudflare:sockets` API 来建立底层 TCP 连接。这意味着它运行在全球 Cloudflare 的边缘网络上。
2.  **VLESS 协议支持:** 它能解析 VLESS 协议的头部信息，包括 VLESS 版本、用户 UUID、附加信息、命令类型（目前只支持 TCP 连接命令 1）、目标端口和目标地址。
3.  **UUID 认证:** 代码强制验证客户端发送的 VLESS 头部中的 UUID 是否与 Workers 环境变量中配置的 `UUID` 匹配。不匹配的连接会被拒绝。
4.  **WebSocket 传输:** VLESS 数据是通过 WebSocket 连接传输的。代码处理 WebSocket 升级请求，并在建立连接后，将 WebSocket 数据流与后端 TCP 连接的数据流进行互相转发 (piping)。它也尝试处理 `sec-websocket-protocol` 头中的早期数据 (early data)，尽管这里只是简单地解析并忽略了可能的错误。
5.  **目标连接 (TCP):** 解析出客户端的目标地址和端口后，代码使用 `cloudflare:sockets` 的 `connect` 函数尝试直接与目标建立 TCP 连接。
6.  **SOCKS5 代理支持 (可选):** 代码支持配置一个 SOCKS5 代理服务器 (`SOCKS5_HOST`, `SOCKS5_PORT`, `SOCKS5_USERNAME`, `SOCKS5_PASSWORD` 环境变量)。如果配置了 SOCKS5，代码会尝试通过这个 SOCKS5 代理去连接最终的目标地址。它实现了 SOCKS5 的连接（CONNECT）命令，包括可选的用户名/密码认证。
7.  **连接重试:** 在将远程数据转发到 WebSocket 的过程中，如果发现远程套接字在没有接收到任何数据就关闭了（`!hasIncomingData`），并且配置了 SOCKS5，它会触发一次重试，尝试通过 SOCKS5 代理重新建立连接。这可能是一个简单的容错或策略切换机制（例如，先尝试直连，失败了再通过 SOCKS5）。
8.  **HTTP 接口:**
    *   **根路径 `/`:** 返回一个简单的文本响应 "VLESS Proxy Server"，用于指示服务正在运行。
    *   **UUID 路径 `/${userID}`:** 返回一个 VLESS 配置链接字符串 (`vless://...`)。这个链接包含了连接到这个 Workers 代理所需的所有信息（UUID, Host, 端口 443, TLS, WebSocket, Path 等），方便用户复制到 VLESS 客户端软件中使用。
    *   **其他 HTTP 路径:** 返回 404 Not Found。
9.  **错误处理:** 代码包含了一些基本的错误处理，例如头部解析失败、UUID 不匹配、命令不支持、SOCKS5 握手或认证失败、连接目标失败等，并在出现错误时关闭连接并返回错误信息。

原始出处： By https://t.me/CF_NAT
