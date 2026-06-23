# 红蓝双轨记牌器

手机优先的小程序风格网页记牌器。红牌、蓝牌分别计数；点击牌面会直接对当前红/蓝轨道减一张，下方“加一张牌”或“减一张牌”可用于补记和纠错。

页面已经做了移动端防误缩放处理，快速连续点击牌面时不应触发浏览器双击放大。

## 本地预览

在项目目录启动静态服务器：

```powershell
python -m http.server 5173
```

然后打开：

```text
http://localhost:5173
```

访问密码：

```text
19970402
```

## 云端共享

当前代码已经预留 Supabase 实时同步。只有填好 Supabase 配置后，多人打开同一个带 `roomId` 的链接才会看到同一套实时牌数。

1. 创建 Supabase 项目。
2. 在 Supabase SQL Editor 运行 `supabase-schema.sql`。
3. 在 Supabase 的 Realtime 设置里确认 `rooms` 表已启用。
4. 编辑 `config.js`，填入：

```js
window.POKER_COUNTER_CONFIG = {
  supabaseUrl: "https://你的项目.supabase.co",
  supabaseAnonKey: "你的 anon public key"
};
```

填好后部署到 Vercel、Netlify 或其他静态托管平台。同一个带 `roomId` 的链接会共享同一局牌数。

GitHub Pages 也可以部署这个静态网页。上传修改后的文件后，等待 Pages 重新发布即可。

## 说明

- 默认红牌 4 副、蓝牌 4 副。
- 大王、小王每副各 1 张；其他牌面每副 4 张。
- 修改某一颜色的副数会直接按新副数重置该颜色剩余牌。
- 点“重新开始”会按当前红蓝副数重置整局。
- 未配置 Supabase 时自动使用本地模式，刷新页面仍会保留当前设备上的牌数，但不同设备之间不会同步。
- 配置 Supabase 后，牌数、副数、当前出牌会实时同步；每台设备自己的红/蓝操作选择互不影响。
