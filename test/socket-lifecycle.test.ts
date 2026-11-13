import { describe, expect, test } from 'bun:test';
import { QuerySocket, type WebSocketLike } from '../src/client/socket';
function deferred<T>() { let resolve!: (value:T)=>void;let reject!: (reason:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; }
function wire(): WebSocketLike { return {send(){},close(){},onopen:null,onmessage:null,onerror:null,onclose:null}; }
describe('connection cancellation',()=>{
  for(const action of ['close','suspend'] as const) {
    test(`${action} while claiming cannot open a late socket`,async()=>{
      const token=deferred<string>();let created=0;
      const socket=new QuerySocket({baseUrl:'wss://example.test',getToken:()=>token.promise,onMessage(){},createWebSocket(){created++;return wire();}});
      const result=socket.connect().then(()=>false,()=>true);
      socket[action]();
      expect(await result).toBe(true);
      token.resolve('test');await Promise.resolve();await Promise.resolve();
      expect(created).toBe(0);expect(socket.isOpen).toBe(false);socket.close();
    });
  }
  test('a replaced claim cannot overwrite or cancel the new connection',async()=>{
    const oldToken=deferred<string>(),newToken=deferred<string>();let calls=0;const wires:WebSocketLike[]=[];
    const socket=new QuerySocket({baseUrl:'wss://example.test',getToken:()=>++calls===1?oldToken.promise:newToken.promise,onMessage(){},createWebSocket(){const ws=wire();wires.push(ws);return ws;}});
    const old=socket.connect().catch(()=>{});
    socket.reconnectNow();
    newToken.resolve('new');await Promise.resolve();await Promise.resolve();
    expect(wires.length).toBe(1);wires[0].onopen?.({});
    oldToken.reject(new Error('old claim failed'));await old;await Promise.resolve();
    expect(socket.isOpen).toBe(true);expect(wires.length).toBe(1);socket.close();
  });
  test('closing during the WebSocket handshake settles the pending connection',async()=>{
    const ws=wire();const socket=new QuerySocket({baseUrl:'wss://example.test',getToken:async()=>'test',onMessage(){},createWebSocket:()=>ws});
    const result=socket.connect().then(()=>false,()=>true);await Promise.resolve();await Promise.resolve();
    socket.close();expect(await result).toBe(true);expect(socket.isOpen).toBe(false);
    ws.onopen?.({});expect(socket.isOpen).toBe(false);
  });
});
