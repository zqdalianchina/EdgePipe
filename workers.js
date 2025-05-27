// --- START OF FILE workers-nat64.js ---

let userID = ''; // Default userID, can be overridden by env.UUID

// Define a default NAT64 prefix.
// The original was '2001:67c:2960:6464::'
// Another common public one is '64:ff9b::' (Cloudflare's, for example, though not for direct use like this usually)
// For nat64.xyz, they list several, e.g., for Trex.fi: '2a01:4f9:c010:3f02::'
const DEFAULT_NAT64_PREFIX = '2001:67c:2960:6464::'; // Or choose another default from nat64.xyz

import { connect } from 'cloudflare:sockets';

// WebSocket 状态常量
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

export default {
  async fetch(request, env, ctx) {
    try {
      // 从环境变量获取配置
      const currentUserID = env.UUID || userID || 'd342d11e-d424-4583-b36e-524ab1f0afa4'; // Ensure userID has a fallback
      if (!userID && env.UUID) { // Set global userID if not set and env.UUID exists, for simplicity in other parts if needed
          userID = env.UUID;
      }
      const nat64Prefix = env.NAT64_PREFIX || DEFAULT_NAT64_PREFIX;
      
      // 检查是否为 WebSocket 升级请求
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        const url = new URL(request.url);
        
        // 处理根路径请求
        if (url.pathname === '/') {
          return new Response('VLESS Proxy Server with NAT64', { status: 200 });
        }
        
        // 处理 UUID 路径请求，返回配置信息
        if (url.pathname === `/${currentUserID}`) {
          const host = request.headers.get('Host');
          const vlessConfig = `vless://${currentUserID}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=/#${host}-NAT64`;
          return new Response(vlessConfig, {
            status: 200,
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          });
        }
        
        return new Response('Not Found', { status: 404 });
      }
      
      // 处理 WebSocket 升级请求
      return await handleVLESSWebSocket(request, currentUserID, nat64Prefix);
    } catch (err) {
      console.error('Fetch error:', err.stack || err);
      return new Response(err.toString(), { status: 500 });
    }
  },
};

// 处理 VLESS WebSocket 连接
async function handleVLESSWebSocket(request, currentUserID, nat64Prefix) {
  const wsPair = new WebSocketPair();
  const [clientWS, serverWS] = Object.values(wsPair);

  serverWS.accept();

  // 处理 WebSocket 数据流
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const wsReadable = createWebSocketReadableStream(serverWS, earlyDataHeader);
  let remoteSocket = null;

  let udpStreamWrite = null;
  let isDns = false;

  // 将IPv4地址转换为NAT64 IPv6地址
  // This function is now defined inside handleVLESSWebSocket to access nat64Prefix
  function convertToNAT64IPv6(ipv4Address) {
    const parts = ipv4Address.split('.');
    if (parts.length !== 4) {
      throw new Error('无效的IPv4地址');
    }
    
    // 将每个部分转换为16进制
    const hex = parts.map(part => {
      const num = parseInt(part, 10);
      if (num < 0 || num > 255) {
        throw new Error('无效的IPv4地址段');
      }
      return num.toString(16).padStart(2, '0');
    });
    
    // 构造NAT64 IPv6地址
    // The prefix should end with '::' if it's a /96 prefix.
    // e.g. nat64Prefix = "2001:67c:2960:6464::" or "64:ff9b::"
    return `[${nat64Prefix}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
  }

  // 获取域名的IPv4地址并转换为NAT64 IPv6地址
  // This function is now defined inside handleVLESSWebSocket
  async function getIPv6ProxyAddress(domain) {
    try {
      const dnsQuery = await fetch(`https://1.1.1.1/dns-query?name=${domain}&type=A`, {
        headers: {
          'Accept': 'application/dns-json'
        }
      });
      
      const dnsResult = await dnsQuery.json();
      if (dnsResult.Answer && dnsResult.Answer.length > 0) {
        // 找到第一个A记录
        const aRecord = dnsResult.Answer.find(record => record.type === 1); // Type 1 for A record
        if (aRecord && aRecord.data) {
          const ipv4Address = aRecord.data;
          return convertToNAT64IPv6(ipv4Address); // convertToNAT64IPv6 uses nat64Prefix from the outer scope
        }
      }
      console.warn(`No A record found for domain: ${domain}`, dnsResult);
      throw new Error('无法解析域名的IPv4地址 (No A record found)');
    } catch (err) {
      console.error(`DNS resolution error for ${domain}:`, err);
      throw new Error(`DNS解析失败: ${err.message}`);
    }
  }
  
  wsReadable.pipeTo(new WritableStream({
    async write(chunk) {
      // 如果是DNS请求且已经有UDP流处理器，直接转发数据
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(chunk);
      }
      
      // 如果已经建立远程连接，直接转发数据
      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      // 解析 VLESS 协议头, pass currentUserID
      const result = parseVLESSHeader(chunk, currentUserID);
      if (result.hasError) {
        // Log error to server, and close WebSocket with a specific error message
        console.error(`VLESS Header Parse Error: ${result.message}. Client UserID in header: ${result.parsedUserID || 'N/A'}`);
        serverWS.close(1008, `VLESS protocol error: ${result.message}`); // 1008: Policy Violation
        throw new Error(result.message);
      }

      // 构造响应头
      const vlessRespHeader = new Uint8Array([result.vlessVersion[0], 0]);
      const rawClientData = chunk.slice(result.rawDataIndex);
      
      // 检查是否为UDP请求
      if (result.isUDP) {
        // 仅支持DNS请求（端口53）
        if (result.portRemote === 53) {
          isDns = true;
          const { write } = await handleUDPOutBound(serverWS, vlessRespHeader);
          udpStreamWrite = write;
          udpStreamWrite(rawClientData);
          return;
        } else {
          const errMsg = 'UDP代理仅支持DNS(端口53)';
          serverWS.close(1003, errMsg); // 1003: Unsupported Data
          throw new Error(errMsg);
        }
      }

      // 建立 TCP 连接
      // connectAndWrite is defined here to capture 'rawClientData' and 'remoteSocket' from the outer scope.
      // This function is now only called for initial direct connection attempt.
      async function connectAndWriteDirect(address, port) {
        console.log(`Attempting direct connection to: ${address}:${port}`);
        const tcpSocket = await connect({
          hostname: address,
          port: port
        });
        remoteSocket = tcpSocket; // Assign to the outer scope remoteSocket
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData); // rawClientData from outer scope
        writer.releaseLock();
        return tcpSocket;
      }


      // 重试函数 - 使用动态NAT64 IPv6地址
      // This function is now defined inside handleVLESSWebSocket to access relevant variables
      async function retryWithNAT64() {
        try {
          let proxyIP;
          
          // 检查是否为IPv4地址格式
          const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
          if (ipv4Regex.test(result.addressRemote)) {
            // 直接将IPv4地址转换为NAT64 IPv6
            proxyIP = convertToNAT64IPv6(result.addressRemote);
            console.log(`Direct IPv4 to NAT64: ${result.addressRemote} -> ${proxyIP}`);
          } else {
            // 域名解析后转换
            console.log(`Resolving domain for NAT64: ${result.addressRemote}`);
            proxyIP = await getIPv6ProxyAddress(result.addressRemote); // Uses scoped getIPv6ProxyAddress
            console.log(`Domain to NAT64: ${result.addressRemote} -> ${proxyIP}`);
          }
          
          console.log(`Attempting NAT64 connection to: ${proxyIP} for port ${result.portRemote}`);
          const tcpSocket = await connect({ // connect is from 'cloudflare:sockets'
            hostname: proxyIP, // proxyIP will be like "[2001::1234:5678]"
            port: result.portRemote
          });
          remoteSocket = tcpSocket; // Assign to the outer scope remoteSocket
          const writer = tcpSocket.writable.getWriter();
          await writer.write(rawClientData); // rawClientData from outer scope
          writer.releaseLock();

          tcpSocket.closed.catch(error => {
            console.error('NAT64 IPv6 connection closed with error:', error);
          }).finally(() => {
            if (serverWS.readyState === WS_READY_STATE_OPEN) {
              serverWS.close(1000, 'NAT64 Connection ended');
            }
          });
          
          // pipeRemoteToWebSocket needs the tcpSocket
          pipeRemoteToWebSocket(tcpSocket, serverWS, vlessRespHeader, null); // No further retry from here
        } catch (err) {
          console.error('NAT64 IPv6 connection failed:', err.stack || err);
          serverWS.close(1011, 'NAT64 IPv6 connection failed: ' + err.message);
        }
      }

      try {
        // First attempt: direct connection (could be IPv4, IPv6, or domain that resolves to IPv6)
        const tcpSocket = await connectAndWriteDirect(result.addressRemote, result.portRemote);
        pipeRemoteToWebSocket(tcpSocket, serverWS, vlessRespHeader, retryWithNAT64); // Pass retryWithNAT64 as the retry function
      } catch (err) {
        console.warn(`Direct connection to ${result.addressRemote}:${result.portRemote} failed: ${err.message}. Will attempt NAT64.`);
        // If direct connection fails, try NAT64 (this is the primary use case for this worker)
        // The original code's retry logic was for when the initial connection succeeded but no data came.
        // Here, we explicitly call retryWithNAT64 if the initial connect itself fails.
        // This might be more aligned with the intent if direct IPv6 is not expected to work often.
        await retryWithNAT64();
      }
    },
    close() {
      console.log('WebSocket readable stream closed.');
      if (remoteSocket) {
        closeSocket(remoteSocket);
      }
    },
    abort(reason){
      console.error('WebSocket readable stream aborted:', reason);
      if (remoteSocket) {
        closeSocket(remoteSocket);
      }
      if (serverWS.readyState === WS_READY_STATE_OPEN || serverWS.readyState === WS_READY_STATE_CLOSING) {
        serverWS.close(1012, 'Stream aborted'); // 1012 Service Restart
      }
    }
  })).catch(err => {
    console.error('WebSocket stream processing error:', err.stack || err);
    if (remoteSocket) {
      closeSocket(remoteSocket);
    }
    if (serverWS.readyState === WS_READY_STATE_OPEN || serverWS.readyState === WS_READY_STATE_CLOSING) {
       serverWS.close(1011, 'Internal stream error');
    }
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
        const data = event.data;
        // Ensure data is ArrayBuffer or Uint8Array
        if (data instanceof ArrayBuffer) {
          controller.enqueue(data);
        } else if (data instanceof Blob) {
          data.arrayBuffer().then(buffer => controller.enqueue(buffer));
        } else if (typeof data === 'string') {
          // This shouldn't happen with VLESS, but handle defensively
           const encoder = new TextEncoder();
           controller.enqueue(encoder.encode(data).buffer);
        } else {
            console.warn('Received unexpected WebSocket data type:', typeof data);
        }
      });
      
      ws.addEventListener('close', event => {
        console.log(`WebSocket closed by server/client: code=${event.code}, reason=${event.reason}`);
        controller.close();
      });
      
      ws.addEventListener('error', err => {
        console.error('WebSocket error event:', err);
        controller.error(err);
      });
      
      // 处理早期数据
      if (earlyDataHeader) {
        try {
          // sec-websocket-protocol is base64url encoded
          const decoded = atob(earlyDataHeader.replace(/-/g, '+').replace(/_/g, '/'));
          const data = Uint8Array.from(decoded, c => c.charCodeAt(0));
          controller.enqueue(data.buffer); // Enqueue ArrayBuffer
        } catch (e) {
          console.warn('Failed to parse early data header:', e);
          // 忽略早期数据解析错误
        }
      }
    }
  });
}

// 解析 VLESS 协议头
// Now takes currentUserID as a parameter
function parseVLESSHeader(buffer, currentUserID) {
  // buffer should be ArrayBuffer
  const view = new DataView(buffer);
  
  // 最小头部长度：1(版本) + 16(UUID) + 1(附加信息长度) + 1(命令) + 2(端口) + 1(地址类型) + 1(地址长度/最小地址)
  if (buffer.byteLength < 1 + 16 + 1 + 1 + 2 + 1 + 1) { // Minimum: 23 bytes
    return { hasError: true, message: `无效的头部长度: ${buffer.byteLength}` };
  }
  
  const version = new Uint8Array(buffer.slice(0, 1));
  
  // 验证 UUID
  const receivedUUIDBytes = new Uint8Array(buffer.slice(1, 17));
  const receivedUUID = formatUUID(receivedUUIDBytes);
  if (receivedUUID !== currentUserID) {
    return { hasError: true, message: '无效的用户', parsedUserID: receivedUUID };
  }
  
  const optionsLength = view.getUint8(17);
  let offset = 18 + optionsLength; // Start of command byte

  if (offset >= buffer.byteLength) {
    return { hasError: true, message: '头部长度不足以读取命令' };
  }
  const command = view.getUint8(offset++);
  
  // 支持 TCP 和 UDP 命令
  let isUDP = false;
  if (command === 1) { // TCP
    // TCP
  } else if (command === 2) { // UDP
    isUDP = true;
  } else {
    return { hasError: true, message: `不支持的命令: ${command}，仅支持TCP(1)和UDP(2)` };
  }
  
  if (offset + 2 > buffer.byteLength) {
    return { hasError: true, message: '头部长度不足以读取端口' };
  }
  const port = view.getUint16(offset); // Port is 2 bytes
  offset += 2;
  
  if (offset >= buffer.byteLength) {
    return { hasError: true, message: '头部长度不足以读取地址类型' };
  }
  const addressType = view.getUint8(offset++);
  let address = '';
  
  switch (addressType) {
    case 1: // IPv4
      if (offset + 4 > buffer.byteLength) {
        return { hasError: true, message: '头部长度不足以读取IPv4地址' };
      }
      address = Array.from(new Uint8Array(buffer.slice(offset, offset + 4))).join('.');
      offset += 4;
      break;
      
    case 2: // 域名
      if (offset >= buffer.byteLength) {
        return { hasError: true, message: '头部长度不足以读取域名长度' };
      }
      const domainLength = view.getUint8(offset++);
      if (offset + domainLength > buffer.byteLength) {
        return { hasError: true, message: '头部长度不足以读取域名' };
      }
      address = new TextDecoder().decode(buffer.slice(offset, offset + domainLength));
      offset += domainLength;
      break;
      
    case 3: // IPv6
      if (offset + 16 > buffer.byteLength) { // IPv6 is 16 bytes
        return { hasError: true, message: '头部长度不足以读取IPv6地址' };
      }
      const ipv6Bytes = new Uint8Array(buffer.slice(offset, offset + 16));
      const ipv6 = [];
      for (let i = 0; i < 16; i += 2) {
        ipv6.push( (ipv6Bytes[i] << 8 | ipv6Bytes[i+1]).toString(16) );
      }
      // Basic canonicalization (leading zeros, ::) - not perfect but functional
      address = ipv6.join(':')
                    .replace(/:(0:)+/g, '::')
                    .replace(/^(0:)+/g, '::')
                    .replace(/:(0)$/g, '::');
      if (address === '0000:0000:0000:0000:0000:0000:0000:0000') address = '::'; // Special case for all zeros
      offset += 16;
      break;
      
    default:
      return { hasError: true, message: `不支持的地址类型: ${addressType}` };
  }
  
  return {
    hasError: false,
    addressRemote: address,
    portRemote: port,
    rawDataIndex: offset,
    vlessVersion: version,
    isUDP
  };
}

// 将远程套接字数据转发到 WebSocket
function pipeRemoteToWebSocket(remoteSocket, ws, vlessHeader, retryFn = null) {
  let headerSent = false;
  let hasIncomingData = false; // Flag to track if any data was received from remote
  let streamClosed = false;

  remoteSocket.readable.pipeTo(new WritableStream({
    async write(chunk) {
      hasIncomingData = true;
      if (ws.readyState === WS_READY_STATE_OPEN) {
        // Ensure chunk is ArrayBuffer
        let bufferChunk = chunk instanceof ArrayBuffer ? chunk : await (new Blob([chunk])).arrayBuffer();

        if (!headerSent) {
          const combined = new Uint8Array(vlessHeader.byteLength + bufferChunk.byteLength);
          combined.set(new Uint8Array(vlessHeader), 0);
          combined.set(new Uint8Array(bufferChunk), vlessHeader.byteLength);
          ws.send(combined.buffer);
          headerSent = true;
        } else {
          ws.send(bufferChunk);
        }
      } else {
        console.warn('Remote data received but WebSocket is not open. State:', ws.readyState);
        // If WS is not open, we might want to abort the remote read.
        // However, pipeTo should handle this by eventually aborting.
      }
    },
    close() {
      streamClosed = true;
      console.log('Remote socket readable stream closed.');
      if (!hasIncomingData && retryFn) {
        console.log('No data received from remote, attempting retry...');
        retryFn(); // Call the retry function (e.g., retryWithNAT64)
        return; // Don't close WebSocket yet, retry will handle it
      }
      if (ws.readyState === WS_READY_STATE_OPEN) {
        ws.close(1000, 'Remote connection closed normally');
      }
    },
    abort(reason) {
      streamClosed = true;
      console.error('Remote socket readable stream aborted:', reason);
      // Abort might be called if the WritableStream (WebSocket side) errors or closes.
      closeSocket(remoteSocket); // Ensure remote socket is cleaned up
      if (ws.readyState === WS_READY_STATE_OPEN) {
        ws.close(1011, 'Remote stream aborted');
      }
    }
  })).catch(err => {
    if (!streamClosed) { // Avoid double logging if already handled by abort/close
        console.error('Error piping remote data to WebSocket:', err.stack || err);
        closeSocket(remoteSocket);
        if (ws.readyState === WS_READY_STATE_OPEN) {
        ws.close(1011, 'Data forwarding error');
        }
    }
  });
}

// 安全关闭套接字
function closeSocket(socket) {
  if (socket) {
    try {
      if (socket.readyState === 'open' || socket.readyState === 'connecting') {
         socket.close();
      }
    } catch (e) {
      console.warn('Error closing socket:', e.message);
      // 忽略关闭错误
    }
  }
}

// 格式化 UUID
function formatUUID(bytes) { // bytes is Uint8Array
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// 处理UDP DNS请求
async function handleUDPOutBound(webSocket, vlessResponseHeader) {
  let isVlessHeaderSent = false;
  const transformStream = new TransformStream({
    start(controller) {
      // 初始化转换流
    },
    transform(chunk, controller) { // chunk is expected to be ArrayBuffer
      const chunkArray = new Uint8Array(chunk);
      // 解析UDP数据包 (VLESS format: 2 bytes length + payload)
      for (let index = 0; index < chunkArray.byteLength;) {
        if (index + 2 > chunkArray.byteLength) {
            console.warn('UDP chunk too small for length header');
            break;
        }
        const lengthBuffer = chunkArray.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer.buffer).getUint16(0);
        
        if (index + 2 + udpPacketLength > chunkArray.byteLength) {
            console.warn(`UDP packet length ${udpPacketLength} exceeds available chunk size ${chunkArray.byteLength - (index + 2)}`);
            break;
        }
        const udpData = chunkArray.slice(index + 2, index + 2 + udpPacketLength);
        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData.buffer); // Enqueue ArrayBuffer
      }
    },
    flush(controller) {
      // 清理转换流
    }
  });

  // 处理DNS请求并发送响应
  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) { // chunk is ArrayBuffer (raw DNS query)
      // 使用Cloudflare的DNS over HTTPS服务
      const resp = await fetch('https://1.1.1.1/dns-query', // or 'https://dns.google/dns-query'
        {
          method: 'POST',
          headers: {
            'content-type': 'application/dns-message',
          },
          body: chunk, // Send ArrayBuffer directly
        });

      if (!resp.ok) {
        console.error(`DNS query failed: ${resp.status} ${resp.statusText}`);
        // Optionally, send an error back through WebSocket if protocol allows
        return;
      }

      const dnsQueryResult = await resp.arrayBuffer(); // This is ArrayBuffer
      const udpSize = dnsQueryResult.byteLength;
      
      // Create VLESS UDP length prefix (2 bytes, big-endian)
      const udpSizeBuffer = new Uint8Array(2);
      new DataView(udpSizeBuffer.buffer).setUint16(0, udpSize);
      
      if (webSocket.readyState === WS_READY_STATE_OPEN) {
        console.log(`DNS query successful, response length ${udpSize}`);
        let messageParts;
        if (isVlessHeaderSent) {
          messageParts = [udpSizeBuffer.buffer, dnsQueryResult];
        } else {
          messageParts = [vlessResponseHeader.buffer, udpSizeBuffer.buffer, dnsQueryResult];
          isVlessHeaderSent = true;
        }
        // Concatenate ArrayBuffers before sending
        const totalLength = messageParts.reduce((sum, part) => sum + part.byteLength, 0);
        const combinedBuffer = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of messageParts) {
            combinedBuffer.set(new Uint8Array(part), offset);
            offset += part.byteLength;
        }
        webSocket.send(combinedBuffer.buffer);
      }
    }
  })).catch((error) => {
    console.error('DNS UDP processing error:', error.stack || error);
    if (webSocket.readyState === WS_READY_STATE_OPEN) {
        webSocket.close(1011, 'DNS processing error');
    }
  });

  const writer = transformStream.writable.getWriter();

  return {
    write(chunk) { // chunk is ArrayBuffer from WebSocket
      writer.write(chunk).catch(e => console.error("UDP stream write error:", e));
    }
  };
}

// --- END OF FILE workers-nat64.js ---
