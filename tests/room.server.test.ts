// The real WebSocket server on a random local port: create, join, sync, origin check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startRoomServer, originAllowed } from "../room/server";

function client(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  const inbox: any[] = [];
  const waiters: { type: string; ok: (m: any) => void }[] = [];
  ws.on("message", d => {
    const m = JSON.parse(d.toString());
    const i = waiters.findIndex(w => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0].ok(m); else inbox.push(m);
  });
  const next = (type: string) => new Promise<any>((ok, fail) => {
    const i = inbox.findIndex(m => m.type === type);
    if (i >= 0) return ok(inbox.splice(i, 1)[0]);
    waiters.push({ type, ok });
    setTimeout(() => fail(new Error(`timed out waiting for ${type}`)), 2000).unref();
  });
  const send = (type: string, body: object = {}) => ws.send(JSON.stringify({ protocolVersion: 1, type, ...body }));
  const opened = new Promise<void>((ok, fail) => { ws.once("open", () => ok()); ws.once("unexpected-response", (_q, res) => fail(new Error(String(res.statusCode)))); ws.once("error", fail); });
  return { ws, next, send, opened };
}

test("host creates over loopback, a phone joins, clock sync round-trips", async () => {
  const srv = await startRoomServer({ port: 0, host: "127.0.0.1" });
  try {
    const url = `ws://127.0.0.1:${srv.port}/room`;
    const host = client(url);
    await host.opened;
    host.send("room.create", { name: "test" });
    const created = await host.next("room.created");
    assert.match(created.code, /^\d{6}$/);

    const phone = client(url);
    await phone.opened;
    phone.send("room.join", { code: created.code, displayName: "Pixel" });
    const joined = await phone.next("room.joined");
    assert.equal(joined.roomId, created.roomId);
    await phone.next("room.snapshot");
    let members = await host.next("room.members");            // the first one was sent at create, empty
    while (members.members.length === 0) members = await host.next("room.members");
    assert.equal(members.members[0].displayName, "Pixel");
    assert.equal(members.members[0].state, "enabling_sound");

    const c0 = performance.now();
    phone.send("sync.request", { requestId: 1, c0 });
    const r = await phone.next("sync.response");
    assert.equal(r.c0, c0);
    assert.equal(r.serverEpochId, srv.manager.serverEpochId);

    phone.send("host.end");
    assert.equal((await phone.next("error")).code, "unauthorized");
    host.ws.close(); phone.ws.close();
  } finally { await srv.close(); }
});

test("sockets from other sites and other paths are refused", async () => {
  const srv = await startRoomServer({ port: 0, host: "127.0.0.1", allowedOrigins: ["https://syncopation.example"] });
  try {
    await assert.rejects(client(`ws://127.0.0.1:${srv.port}/room`, { origin: "https://evil.example" }).opened, /403/);
    await assert.rejects(client(`ws://127.0.0.1:${srv.port}/other`).opened, /403/);
    const ok = client(`ws://127.0.0.1:${srv.port}/room`, { origin: "https://syncopation.example" });
    await ok.opened;
    ok.ws.close();
  } finally { await srv.close(); }
});

test("origin rule: same host or listed origin only", () => {
  assert.equal(originAllowed(undefined, "x:1", []), true);
  assert.equal(originAllowed("http://192.168.1.5:5176", "192.168.1.5:5176", []), true);
  assert.equal(originAllowed("http://evil.example", "192.168.1.5:5176", []), false);
  assert.equal(originAllowed("not a url", "x", []), false);
});
