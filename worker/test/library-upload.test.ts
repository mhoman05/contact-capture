import { it, expect } from "vitest";
import { FakeNotion } from "./fake-notion";
import { NotionClient } from "../src/notion";
import { libraryUpload, digest, PART } from "../src/backup";
import { loadBackup, saveBackup } from "../src/backup";
it("keeps incomplete data out of restore, resumes and verifies complete exact data with duplicate-safe chunks", async () => {
  const f = new FakeNotion(),
    n = new NotionClient("test", f.fetch),
    db = "backup";
  await saveBackup(n, db, { app: "library", data: "raw:QUJD", device: "old" });
  const data = "raw:" + "QUJD".repeat(100000),
    hash = await digest(data),
    manifest = {
      hash,
      length: data.length,
      count: Math.ceil(data.length / PART),
      device: "test",
    };
  const start: any = await libraryUpload(n, db, "start", manifest);
  await expect(
    libraryUpload(n, db, "commit", { id: start.id }),
  ).rejects.toThrow("incomplete");
  expect((await loadBackup(n, db, "library"))?.data).toBe("raw:QUJD");
  for (let i = 0; i < manifest.count; i++) {
    const part = {
      id: start.id,
      i,
      data: data.slice(i * PART, (i + 1) * PART),
    };
    await libraryUpload(n, db, "part", part);
    await libraryUpload(n, db, "part", part);
  }
  expect(f.rows[1].children).toHaveLength(1 + manifest.count);
  expect(
    ((await libraryUpload(n, db, "start", manifest)) as any).received,
  ).toHaveLength(manifest.count);
  expect(
    ((await libraryUpload(n, db, "commit", { id: start.id })) as any).hash,
  ).toBe(hash);
  expect((await loadBackup(n, db, "library"))?.data).toBe(data);
  expect(f.rows[0].archived).not.toBe(true);
});
it("does not promote corrupted chunks or write to unrelated pages", async () => {
  const f = new FakeNotion(),
    n = new NotionClient("test", f.fetch);
  const data = "raw:QUJD",
    m = { hash: await digest(data), length: data.length, count: 1 };
  const s: any = await libraryUpload(n, "backup", "start", m);
  await libraryUpload(n, "backup", "part", { id: s.id, i: 0, data });
  const c = f.rows[0].children![1].code.rich_text;
  c[0].text.content = c[0].text.content.replace("QUJD", "QUJE");
  await expect(
    libraryUpload(n, "backup", "commit", { id: s.id }),
  ).rejects.toThrow("Invalid stored");
  expect(f.rows[0].properties.App.title[0].text.content).toContain("upload");
  await expect(
    libraryUpload(n, "different", "part", { id: s.id, i: 0, data }),
  ).rejects.toThrow("Not a Library");
});
it("surfaces full rate pauses instead of retrying early for Library operations", async () => {
  let calls = 0;
  const n = new NotionClient(
    "test",
    async () => {
      calls++;
      return new Response("{}", {
        status: 429,
        headers: { "Retry-After": "120" },
      });
    },
    true,
  );
  await expect(n.getPage("test")).rejects.toMatchObject({
    status: 429,
    retryAfter: 120,
  });
  expect(calls).toBe(1);
});

it("retains three completed v2 backups while protecting every legacy snapshot", async () => {
  const f = new FakeNotion(), n = new NotionClient("test", f.fetch), db = "backup";
  await saveBackup(n, db, {app:"library", data:"raw:QUJD", device:"old"});
  for(let j=0;j<5;j++){
    const data="raw:"+btoa("version"+j), hash=await digest(data);
    const m={hash,length:data.length,count:1};
    const s:any=await libraryUpload(n,db,"start",m);
    await libraryUpload(n,db,"part",{id:s.id,i:0,data});
    await libraryUpload(n,db,"commit",{id:s.id});
  }
  expect(f.rows[0].archived).not.toBe(true);
  expect(f.rows.filter(p=>!p.archived)).toHaveLength(4);
});
