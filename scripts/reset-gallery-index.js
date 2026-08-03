import { config } from "../server/config.js";
import { D1Database } from "../server/db.js";
import { ensureSchema } from "../functions/_lib/db.js";

const confirmed = process.argv.slice(2).includes("--confirm");
const db = new D1Database(config.dbPath);

try {
  await ensureSchema(db);
  const [images, comments, friends, sessions] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM gallery_items").first(),
    db.prepare("SELECT COUNT(*) AS count FROM photo_comments").first(),
    db.prepare("SELECT COUNT(*) AS count FROM gallery_friends").first(),
    db.prepare("SELECT COUNT(*) AS count FROM friend_sessions").first(),
  ]);

  console.log("将重建图库索引，但不会删除任何图片文件。");
  console.log(`将删除：图片索引 ${images?.count || 0}，照片留言 ${comments?.count || 0}`);
  console.log(`将保留：好友 ${friends?.count || 0}，好友会话 ${sessions?.count || 0}，分类和站点设置`);
  console.log(`数据库：${config.dbPath}`);
  console.log(`图片目录：${config.storageRoot}`);

  if (!confirmed) {
    console.log("当前为预览模式，未修改任何数据。确认备份后追加 --confirm 执行。");
  } else {
    await db.batch([
      db.prepare("DELETE FROM photo_comments"),
      db.prepare("DELETE FROM gallery_items"),
      db.prepare("DELETE FROM gallery_snapshots"),
      db.prepare("DELETE FROM gallery_settings WHERE key = 'hero_image_id'"),
    ]);
    console.log("图库索引已清空；好友、好友会话、分类和图片文件均已保留。");
  }
} finally {
  db.close();
}
