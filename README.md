# 一ノ瀬林檎的小洛克冒险之旅

这是一个适合单台 VPS 部署的私人图片图库，包含公开图库、管理后台、批量上传、分类、置顶、精选、标题图、好友登录和照片留言。

当前版本使用：

- Node.js 24
- SQLite
- VPS 本地图片存储
- Caddy 自动 HTTPS
- Docker Compose
- GitHub Actions + GitHub Container Registry（GHCR）
- Sharp 上传时生成 WebP 缩略图和预览图

## 图片加载与清晰度

上传图片后，服务器只在上传时处理一次，同时保存三种版本：

| 版本 | 用途 | 默认参数 |
| --- | --- | --- |
| 原图 | 下载、打开原图 | 保留上传文件，不重新压缩 |
| 缩略图 | 图库卡片、后台列表 | 最大宽度 1024px，WebP quality 82 |
| 预览图 | 标题图、灯箱大图 | 最大宽度 2048px，WebP quality 86 |

1024px 缩略图可以覆盖约 400～500 CSS 像素宽、2 倍设备像素比的现代手机和桌面屏幕，避免为了省几十 KB 而让高分屏看起来模糊。原始 4K 图片仍会保留。

图库首批只渲染 12 张图片，接近页面底部时再分批加载。第一屏使用正常优先级，其余图片使用原生懒加载。好友会话接口不会再阻塞图库渲染。

### 2 核 2 GB 与 8 核 8 GB 服务器

图片处理默认自动读取容器可用的 CPU 与内存，不填写环境变量即可使用以下档位：

| 服务器 | 同时处理图片 | Sharp 每图片线程 | Sharp 内存缓存 |
| --- | ---: | ---: | ---: |
| 2C2G（或 CPU 不超过 2 核、内存不超过 3 GB） | 1 | 2 | 32 MB |
| 8C8G 等较大服务器 | 2 | 4 | 128 MB |

缩略图和预览图在每个图片任务内顺序生成，因此 2C2G 不会因为一张图同时运行两条 Sharp 流水线而额外超额占用 CPU。8C8G EPYC 足够使用。

如需手动覆盖，可在 `.env` 填写：

```dotenv
IMAGE_PROCESS_CONCURRENCY=2
IMAGE_PROCESS_THREADS=4
IMAGE_PROCESS_CACHE_MB=128
IMAGE_MAX_PIXELS=40000000
```

无论自动选择哪个档位，管理后台仍会同时发起 10 个上传请求；超出服务端处理上限的请求只会排队，不会同时解码 10 张 4K 图片。小于 500 KB 只是压缩后的文件大小，4K 图片解码后仍会占用数十 MB 内存，因此 2C2G 默认采用更保守的单图片处理。

`IMAGE_PROCESS_CONCURRENCY` 控制的是服务器实际同时转码的图片数量，不是浏览器同时上传的文件数量。图库访问本身不需要实时转码，访客读取的是已经生成好的文件。

## 数据位置和安全边界

Docker 部署默认使用四个持久卷：

| 卷 | 容器路径 | 内容 |
| --- | --- | --- |
| `gallery_data` | `/app/data` | SQLite、原图、缩略图和预览图 |
| `gallery_backups` | `/app/backups` | 应用生成的备份 |
| `caddy_data` | `/data` | Caddy 证书和状态 |
| `caddy_config` | `/config` | Caddy 运行配置 |

图片路径默认是 `/app/data/images`，数据库默认是 `/app/data/gallery.sqlite`。

应用容器具有以下限制：

- 使用非 root 的 `node` 用户运行。
- 根文件系统只读。
- 仅 `/app/data`、`/app/backups` 和临时内存目录可写。
- 删除全部 Linux capabilities。
- 启用 `no-new-privileges`。
- Node 的 3000 端口只在 Compose 内部网络暴露，不直接映射到公网。
- `.dockerignore` 排除 `.env`、数据库、图片、备份、Git 历史和 `node_modules`，避免秘密或私人图片进入镜像层。

`gallery_backups` 虽然与主数据分卷，但仍位于同一台 VPS。请定期把备份复制到另一台机器或对象存储；同机备份无法抵御整盘损坏或 VPS 丢失。

## 一、准备服务器

建议使用 Debian 12/13 或 Ubuntu LTS，并安装 Docker Engine 与 Compose 插件。

先确认系统：

```bash
cat /etc/os-release
docker version
docker compose version
```

防火墙至少需要允许 SSH、HTTP、HTTPS 和 HTTP/3。以下只是示例；如果服务器还有 Xray 或其他服务，请先核对现有规则：

```bash
sudo ufw status numbered
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

确认域名的 A/AAAA 记录已经指向 VPS。若使用 Cloudflare，建议开启代理，并为 `/gallery/*` 创建缓存规则，然后通过浏览器检查图片响应的 `CF-Cache-Status`。

## 二、从自己的 GitHub 仓库构建镜像

### 1. Fork 或复制仓库

将仓库 Fork 到自己的 GitHub 账号，或者复制到新仓库：

```bash
git clone https://github.com/Ichinose520122/roco-world.git
cd roco-world
git remote rename origin upstream
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

如果使用 Fork，直接在 GitHub 网页启用 Actions 即可。

### 2. GitHub Actions 权限

进入仓库：

```text
Settings → Actions → General → Workflow permissions
```

选择：

```text
Read and write permissions
```

工作流会执行：

1. `npm ci`
2. Node.js 测试
3. Docker Buildx 构建 linux/amd64 镜像
4. 推送到 `ghcr.io/<仓库所有者>/<仓库名>`

推送 `main` 后会生成：

```text
ghcr.io/你的用户名/你的仓库名:latest
ghcr.io/你的用户名/你的仓库名:sha-提交摘要
```

推送版本标签会生成对应标签：

```bash
git tag v1.0.0
git push origin v1.0.0
```

然后可以固定部署：

```text
ghcr.io/你的用户名/你的仓库名:v1.0.0
```

### 3. 设置 GHCR 可见性

在 GitHub 个人主页或组织页面进入：

```text
Packages → roco-world → Package settings → Change visibility
```

公开镜像可以直接拉取。私人镜像需要在 VPS 登录 GHCR。

创建只包含 `read:packages` 权限的 Personal Access Token，然后在 VPS 执行：

```bash
read -p 'GitHub 用户名: ' GHCR_USER
read -s -p 'GHCR Token: ' GHCR_TOKEN
echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
unset GHCR_TOKEN
```

不要把 Token 写入 `.env`、Compose 文件或 shell 历史。

## 三、首次 Docker 部署

### 1. 获取部署文件

```bash
git clone https://github.com/你的用户名/你的仓库名.git
cd 你的仓库名
cp .env.example .env
```

生成随机密码：

```bash
openssl rand -base64 36
openssl rand -base64 48
```

编辑 `.env`：

```dotenv
DOMAIN=roco.example.com
APP_IMAGE=ghcr.io/你的用户名/你的仓库名:latest

ADMIN_USERNAME=admin
ADMIN_PASSWORD=至少16位的随机密码
FRIEND_ID_SECRET=至少32位且长期不变的随机值

# 留空使用自动档位；2C2G 自动为 1/2/32，8C8G 自动为 2/4/128
IMAGE_PROCESS_CONCURRENCY=
IMAGE_PROCESS_THREADS=
IMAGE_PROCESS_CACHE_MB=
IMAGE_MAX_PIXELS=40000000
```

`FRIEND_ID_SECRET` 用于好友学号 HMAC，后续不要随意更换。更换后原有学号摘要将无法匹配。

限制 `.env` 权限：

```bash
chmod 600 .env
```

### 2. 检查配置

```bash
docker compose config
```

确认：

- `APP_IMAGE` 指向自己的 GHCR 仓库。
- `DOMAIN` 是正式域名。
- 没有把 Node 3000 端口映射到公网。
- `gallery_data` 和 `gallery_backups` 都存在。

### 3. 拉取并启动

使用 GitHub 构建的镜像：

```bash
docker compose pull
docker compose up -d --no-build
```

检查状态：

```bash
docker compose ps
docker compose logs --tail=100 app
docker compose logs --tail=100 caddy
curl -fsS https://你的域名/healthz
```

访问：

- 首页：`https://你的域名/`
- 管理后台：`https://你的域名/admin/`
- 健康检查：`https://你的域名/healthz`

### 4. 在 VPS 本地构建

如果暂时不使用 GHCR：

```bash
docker compose build --pull app
docker compose up -d --no-build
```

`.dockerignore` 会阻止本地 `.env`、图片和 SQLite 进入构建上下文。

## 四、更新部署

先备份：

```bash
docker compose exec app npm run backup
```

使用 `latest` 更新：

```bash
docker compose pull app caddy
docker compose up -d --no-build --remove-orphans
docker compose ps
docker compose logs --tail=100 app
curl -fsS https://你的域名/healthz
```

使用固定版本更新时，先修改 `.env`：

```dotenv
APP_IMAGE=ghcr.io/你的用户名/你的仓库名:v1.0.1
```

然后执行同样的 `pull` 和 `up` 命令。

如果只修改了本地代码并需要本地重建：

```bash
docker compose build --pull app
docker compose up -d --no-build --force-recreate app
```

## 五、为已有图片生成缩略图和预览图

新上传的图片会自动生成两个变体。升级前已经存在的图片执行一次：

```bash
docker compose exec app npm run images:backfill
```

先用少量图片测试：

```bash
docker compose exec app npm run images:backfill -- --limit=10
```

已有变体默认会跳过。需要重新生成全部变体时：

```bash
docker compose exec app npm run images:backfill -- --force
```

处理过程中可以继续浏览图库，但首次大批量处理建议选择访问量较低的时间。脚本逐张处理，并受服务器端图片任务并发限制保护。

检查接口：

```bash
curl -I 'https://你的域名/gallery/图片ID?variant=thumbnail'
curl -I 'https://你的域名/gallery/图片ID?variant=preview'
curl -I 'https://你的域名/gallery/图片ID'
```

成功生成的缩略图和预览图应返回：

```text
Content-Type: image/webp
Cache-Control: public, max-age=31536000, immutable
```

若旧图尚未生成变体，接口会临时回退原图，并只缓存 5 分钟。

## 六、备份与恢复

### 创建备份

访问量低且后台没有执行上传/删除时，可以在线备份：

```bash
docker compose exec app npm run backup
docker compose exec app sh -c 'ls -lah /app/backups'
```

需要数据库与图片目录严格一致时，短暂停止应用并使用一次性容器：

```bash
docker compose stop app
docker compose run --rm app npm run backup
docker compose up -d app
```

上传逻辑会先完整保存原图和两个变体，再写入数据库，可以降低在线备份的不一致风险；但管理员删除操作仍可能与图片复制竞争，因此正式恢复点推荐使用停机备份。

备份内容包括：

- 一致性的 `gallery.sqlite`
- 原图、缩略图和预览图
- `backup.json`

备份不包含 `.env`。请单独加密保存 `.env`。

将备份复制到宿主机：

```bash
mkdir -p ./exported-backups
docker compose cp app:/app/backups/备份时间目录 ./exported-backups/
```

再同步到异地：

```bash
rsync -a --info=progress2 ./exported-backups/ backup-user@backup-host:/srv/roco-backups/
```

### 恢复

先停止应用并保留 Caddy：

```bash
docker compose stop app
```

将备份复制回数据卷：

```bash
docker compose cp ./exported-backups/备份时间/gallery.sqlite app:/app/data/gallery.sqlite
docker compose cp ./exported-backups/备份时间/images/. app:/app/data/images/
docker compose up -d app
docker compose logs --tail=100 app
```

恢复前应再备份当前状态。不要运行：

```text
docker compose down -v
docker volume prune
docker system prune --volumes
```

这些命令可能删除图库数据卷和证书卷。

## 七、重建图库索引但保留好友

适用于准备重新上传全部图片、但希望保留好友账号和登录状态的情况。

脚本会：

- 删除 `gallery_items` 图片索引。
- 删除依赖旧图片 ID 的照片留言。
- 清除图库快照和手动标题图 ID。
- 保留好友账号、好友会话、登录限制记录、分类和其他站点设置。
- 不删除任何图片文件。

先备份：

```bash
docker compose exec app npm run backup
```

停止应用，使用一次性容器预览影响：

```bash
docker compose stop app
docker compose run --rm app npm run gallery:reset-index
```

确认输出中的数量后才执行：

```bash
docker compose run --rm app npm run gallery:reset-index -- --confirm
docker compose up -d
```

如果需要保留照片留言，不要重建图片索引；应保留数据库和图片 ID，只运行缩略图补全脚本。

## 八、使用新的独立图片卷

仓库提供 `compose.images-v2.example.yaml`。复制为本地 override：

```bash
cp compose.images-v2.example.yaml compose.images-v2.yaml
```

之后所有 Compose 命令使用两个文件：

```bash
docker compose -f compose.yaml -f compose.images-v2.yaml config
```

新卷会挂载到 `/app/images`，并把 `STORAGE_ROOT` 改为该目录。旧的 `/app/data/images` 不会被删除。

### 方案 A：保留现有索引、好友和留言，只迁移图片

```bash
docker compose stop app
docker compose -f compose.yaml -f compose.images-v2.yaml run --rm app \
  sh -c 'cp -a /app/data/images/. /app/images/'
docker compose -f compose.yaml -f compose.images-v2.yaml run --rm app \
  npm run images:backfill
docker compose -f compose.yaml -f compose.images-v2.yaml up -d
```

这条路径保留图片 ID，因此也能保留照片留言。

### 方案 B：使用空的新图片卷并重新上传

```bash
docker compose stop app
docker compose -f compose.yaml -f compose.images-v2.yaml run --rm app \
  npm run gallery:reset-index
docker compose -f compose.yaml -f compose.images-v2.yaml run --rm app \
  npm run gallery:reset-index -- --confirm
docker compose -f compose.yaml -f compose.images-v2.yaml up -d
```

随后从管理后台重新上传。此方案保留好友，但旧照片留言会被删除。

不要在确认新卷完整前删除旧卷。查看卷：

```bash
docker volume ls
docker system df -v
```

## 九、从 D1 和 R2 迁移

迁移必须同时包含：

1. D1 导出的 SQL。
2. R2 的全部图片对象，并保留原始 `object_key` 目录结构。

导入数据库：

```bash
docker compose stop app
docker compose run --rm \
  -v "$PWD/d1-export.sql:/tmp/d1-export.sql:ro" \
  app npm run import:d1 -- /tmp/d1-export.sql
```

复制 R2 对象到 `STORAGE_ROOT` 后生成变体：

```bash
docker compose run --rm app npm run images:backfill
docker compose up -d
```

详细旧版迁移背景参见 `docs/MIGRATION.md`。执行覆盖导入前必须备份。

## 十、直接运行与开发测试

本地需要 Node.js 24：

```bash
npm ci
cp .env.example .env
npm run check
npm start
```

生产环境如果不使用 Docker，可以参考：

- `deploy/roco-gallery.service`
- `deploy/Caddyfile`
- `deploy/nginx.conf`

systemd 示例已经启用 `NoNewPrivileges`、`ProtectHome`、`ProtectSystem=strict` 和仅允许写入数据目录。安装 Sharp 后必须先执行 `npm ci --omit=dev`。

## 十一、常用排查命令

```bash
# 容器状态
docker compose ps

# 应用日志
docker compose logs -f --tail=200 app

# Caddy 日志
docker compose logs -f --tail=200 caddy

# Compose 最终配置
docker compose config

# 健康检查
curl -fsS https://你的域名/healthz

# 图片缓存头
curl -I 'https://你的域名/gallery/图片ID?variant=thumbnail'

# 数据卷占用
docker system df -v

# 容器内数据目录
docker compose exec app sh -c 'du -sh /app/data /app/backups'

# 当前图片处理配置
docker compose exec app sh -c 'env | grep ^IMAGE_ | sort'
```

如果图片仍然偶发慢，请在浏览器开发者工具的 Network 面板检查：

- 图片是否请求 `?variant=thumbnail`。
- 第一屏图片 Priority 是否为 High/Medium 或 Auto，而不是全部 Low。
- `Transferred` 是否来自 memory cache/disk cache。
- `Waiting (TTFB)` 与 `Content Download` 哪一段耗时。
- 使用 Cloudflare 时 `CF-Cache-Status` 是否为 `HIT`。
- 图片是否在 `/api/friend/session` 完成前已经开始请求。

## 十二、重要注意事项

- 不要提交 `.env`。
- 不要公开 Node 3000 端口。
- 不要更换 `FRIEND_ID_SECRET`，除非准备重新录入好友学号。
- 不要让多台应用服务器通过网络共享盘同时写同一个 SQLite。
- 不要运行带 `-v` 的 `docker compose down`，除非确认要永久删除数据。
- GitHub Actions 构建的默认镜像名是 `ghcr.io/<所有者>/<仓库名>`，必须与 `.env` 的 `APP_IMAGE` 一致。
- 同机备份不等于异地备份。


## 好友留言与后台认证

填写游戏 ID（原游戏名称字段）和学号即可建立留言身份，无需提前加入好友名单。
新身份可以正常留言，但显示“待认证”；管理员在“好友管理”中勾选“已认证”并保存后，身份及其历史留言显示“已认证”。取消勾选可撤销认证，停用账号仍会禁止登录和留言。

更新后首次启动会自动增加认证字段，原有好友保留为已认证，已有登录会话、照片及留言不变。后台直接添加的好友也视为已认证。
同一学号继续对应同一身份，重复登录复用账号；ID 不匹配或账号已停用时拒绝登录。修改学号会让旧会话失效。学号仍仅保存 HMAC，必须保留原有 `FRIEND_ID_SECRET`。
