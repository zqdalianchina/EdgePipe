let userID = '';
let socks5Config = {
  host: '',
  port: '',
  username: '',
  password: ''
};

import { connect } from 'cloudflare:sockets';

// WebSocket 状态常量
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

export default {
  async fetch(request, env, ctx) {
    try {
      // 从环境变量获取配置
      userID = env.UUID || userID;
      if (env.SOCKS5_HOST) {
        socks5Config.host = env.SOCKS5_HOST;
        socks5Config.port = parseInt(env.SOCKS5_PORT || '');
        socks5Config.username = env.SOCKS5_USERNAME || '';
        socks5Config.password = env.SOCKS5_PASSWORD || '';
      }
      
      // 检查是否为 WebSocket 升级请求
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        const url = new URL(request.url);
        
        // 处理根路径请求
        if (url.pathname === '/') {
          return new Response('VLESS Proxy Server', { status: 200 });
        }
        
        // 处理 UUID 路径请求，返回配置信息
        if (url.pathname === `/${userID}`) {
          const host = request.headers.get('Host');
          const vlessConfig = `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=/#${host}`;
          return new Response(vlessConfig, {
            status: 200,
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          });
        }
        
        return new Response('Not Found', { status: 404 });
      }
      
      // 处理 WebSocket 升级请求
      return await handleVLESSWebSocket(request);
    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  },
};

// 处理 VLESS WebSocket 连接
async function handleVLESSWebSocket(request) {
  const wsPair = new WebSocketPair();
  const [clientWS, serverWS] = Object.values(wsPair);

  serverWS.accept();

  // 处理 WebSocket 数据流
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const wsReadable = createWebSocketReadableStream(serverWS, earlyDataHeader);
  let remoteSocket = null;

  wsReadable.pipeTo(new WritableStream({
    async write(chunk) {
      // 如果已经建立远程连接，直接转发数据
      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      // 解析 VLESS 协议头
      const result = parseVLESSHeader(chunk, userID);
      if (result.hasError) {
        throw new Error(result.message);
      }

      // 构造响应头
      const vlessRespHeader = new Uint8Array([result.vlessVersion[0], 0]);
      const rawClientData = chunk.slice(result.rawDataIndex);

      // 建立 TCP 连接
      async function connectAndWrite(address, port) {
        const tcpSocket = await connect({
          hostname: address,
          port: port
        });
        remoteSocket = tcpSocket;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
      }

      // 通过SOCKS5代理连接
      async function connectViaSocks5(address, port) {
        const sock = await connect({
          hostname: socks5Config.host,
          port: socks5Config.port
        });

        // SOCKS5初始握手
        const auth = socks5Config.username && socks5Config.password ? 0x02 : 0x00;
        const init = new Uint8Array([0x05, 0x01, auth]);
        const writer = sock.writable.getWriter();
        await writer.write(init);

        // 读取响应
        const reader = sock.readable.getReader();
        const {value: initRes} = await reader.read();
        if (initRes[0] !== 0x05 || initRes[1] !== auth) {
          throw new Error('SOCKS5初始握手失败');
        }

        // 如果需要认证
        if (auth === 0x02) {
          const userLen = socks5Config.username.length;
          const passLen = socks5Config.password.length;
          const authReq = new Uint8Array(3 + userLen + passLen);
          authReq[0] = 0x01; // 版本
          authReq[1] = userLen;
          authReq.set(new TextEncoder().encode(socks5Config.username), 2);
          authReq[2 + userLen] = passLen;
          authReq.set(new TextEncoder().encode(socks5Config.password), 3 + userLen);
          await writer.write(authReq);

          const {value: authRes} = await reader.read();
          if (authRes[0] !== 0x01 || authRes[1] !== 0x00) {
            throw new Error('SOCKS5认证失败');
          }
        }

        // 发送连接请求
        const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(address);
        const addrLen = isIP ? 4 : address.length;
        const connectReq = new Uint8Array(7 + addrLen);
        connectReq[0] = 0x05; // 版本
        connectReq[1] = 0x01; // CONNECT命令
        connectReq[2] = 0x00; // 保留字段
        connectReq[3] = isIP ? 0x01 : 0x03; // 地址类型：IPv4或域名

        if (isIP) {
          connectReq.set(address.split('.').map(Number), 4);
        } else {
          connectReq[4] = addrLen;
          connectReq.set(new TextEncoder().encode(address), 5);
        }

        const portIndex = isIP ? 8 : 5 + addrLen;
        connectReq[portIndex] = port >> 8;
        connectReq[portIndex + 1] = port & 0xff;

        await writer.write(connectReq);

        // 读取响应
        const {value: connectRes} = await reader.read();
        if (connectRes[0] !== 0x05 || connectRes[1] !== 0x00) {
          throw new Error('SOCKS5连接请求失败');
        }

        writer.releaseLock();
        reader.releaseLock();
        return sock;
      }

      // 重试函数
      async function retry() {
        if (!socks5Config.host) {
          console.error('未配置SOCKS5代理');
          serverWS.close(1011, 'No SOCKS5 proxy configured');
          return;
        }

        try {
          const tcpSocket = await connectViaSocks5(result.addressRemote, result.portRemote);
          remoteSocket = tcpSocket;
          const writer = tcpSocket.writable.getWriter();
          await writer.write(rawClientData);
          writer.releaseLock();

          tcpSocket.closed.catch(error => {
            console.error('重试连接关闭错误:', error);
          }).finally(() => {
            if (serverWS.readyState === WS_READY_STATE_OPEN) {
              serverWS.close(1000, 'Connection closed');
            }
          });
          pipeRemoteToWebSocket(tcpSocket, serverWS, vlessRespHeader, null);
        } catch (err) {
          console.error('SOCKS5重试连接失败:', err);
          serverWS.close(1011, 'SOCKS5 retry connection failed');
        }
      }

      try {
        const tcpSocket = await connectAndWrite(result.addressRemote, result.portRemote);
        pipeRemoteToWebSocket(tcpSocket, serverWS, vlessRespHeader, retry);
      } catch (err) {
        console.error('连接失败:', err);
        serverWS.close(1011, 'Connection failed');
      }
    },
    close() {
      if (remoteSocket) {
        closeSocket(remoteSocket);
      }
    }
  })).catch(err => {
    console.error('WebSocket 错误:', err);
    closeSocket(remoteSocket);
    serverWS.close(1011, 'Internal error');
  });

  return new Response(null, {
    status: 101,
    webSocket: clientWS,
  });
}

// 创建 WebSocket 可读流
function createWebSocketReadableStream(ws, earlyDataHeader) {
  return new ReadableStream({
    start(controller) {
      ws.addEventListener('message', event => {
        controller.enqueue(event.data);
      });
      
      ws.addEventListener('close', () => {
        controller.close();
      });
      
      ws.addEventListener('error', err => {
        controller.error(err);
      });
      
      // 处理早期数据
      if (earlyDataHeader) {
        try {
          const decoded = atob(earlyDataHeader.replace(/-/g, '+').replace(/_/g, '/'));
          const data = Uint8Array.from(decoded, c => c.charCodeAt(0));
          controller.enqueue(data.buffer);
        } catch (e) {
          // 忽略早期数据解析错误
        }
      }
    }
  });
}

// 解析 VLESS 协议头
function parseVLESSHeader(buffer, userID) {
  // 最小头部长度：1(版本) + 16(UUID) + 1(附加信息长度) + 1(命令) + 2(端口) + 1(地址类型) + 1(地址长度) + 1(最小地址)
  if (buffer.byteLength < 24) {
    return { hasError: true, message: 'Invalid header length' };
  }
  
  const view = new DataView(buffer);
  const version = new Uint8Array(buffer.slice(0, 1));
  
  // 验证 UUID
  const uuid = formatUUID(new Uint8Array(buffer.slice(1, 17)));
  if (uuid !== userID) {
    return { hasError: true, message: 'Invalid user' };
  }
  
  const optionsLength = view.getUint8(17);
  const command = view.getUint8(18 + optionsLength);
  
  // 仅支持 TCP 命令
  if (command !== 1) {
    return { hasError: true, message: 'Only TCP is supported' };
  }
  
  let offset = 19 + optionsLength;
  const port = view.getUint16(offset);
  offset += 2;
  
  // 解析地址
  const addressType = view.getUint8(offset++);
  let address = '';
  
  switch (addressType) {
    case 1: // IPv4
      address = Array.from(new Uint8Array(buffer.slice(offset, offset + 4))).join('.');
      offset += 4;
      break;
      
    case 2: // 域名
      const domainLength = view.getUint8(offset++);
      address = new TextDecoder().decode(buffer.slice(offset, offset + domainLength));
      offset += domainLength;
      break;
      
    case 3: // IPv6
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(view.getUint16(offset).toString(16).padStart(4, '0'));
        offset += 2;
      }
      address = ipv6.join(':').replace(/(^|:)0+(\w)/g, '$1$2');
      break;
      
    default:
      return { hasError: true, message: 'Unsupported address type' };
  }
  
  return {
    hasError: false,
    addressRemote: address,
    portRemote: port,
    rawDataIndex: offset,
    vlessVersion: version
  };
}

// 将远程套接字数据转发到 WebSocket
function pipeRemoteToWebSocket(remoteSocket, ws, vlessHeader, retry = null) {
  let headerSent = false;
  let hasIncomingData = false;
  
  remoteSocket.readable.pipeTo(new WritableStream({
    write(chunk) {
      hasIncomingData = true;
      if (ws.readyState === WS_READY_STATE_OPEN) {
        if (!headerSent) {
          // 发送 VLESS 响应头
          const combined = new Uint8Array(vlessHeader.byteLength + chunk.byteLength);
          combined.set(new Uint8Array(vlessHeader), 0);
          combined.set(new Uint8Array(chunk), vlessHeader.byteLength);
          ws.send(combined.buffer);
          headerSent = true;
        } else {
          ws.send(chunk);
        }
      }
    },
    close() {
      if (!hasIncomingData && retry) {
        retry();
        return;
      }
      if (ws.readyState === WS_READY_STATE_OPEN) {
        ws.close(1000, 'Normal closure');
      }
    },
    abort() {
      closeSocket(remoteSocket);
    }
  })).catch(err => {
    console.error('数据转发错误:', err);
    closeSocket(remoteSocket);
    if (ws.readyState === WS_READY_STATE_OPEN) {
      ws.close(1011, 'Data transfer error');
    }
  });
}

// 安全关闭套接字
function closeSocket(socket) {
  if (socket) {
    try {
      socket.close();
    } catch (e) {
      // 忽略关闭错误
    }
  }
}

// 格式化 UUID
function formatUUID(bytes) {
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}