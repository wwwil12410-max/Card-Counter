# 红蓝双轨记牌器

手机优先的网页记牌器。红牌、蓝牌分别计数；点击牌面会按当前红/蓝轨道立即减 1，下方按钮可用于手动加减和重新开始。

## 当前访问模式

- 房主打开普通链接，输入登录密码进入。
- 房主点击“控制台”后，可以关闭/开启本局、生成玩家 24 小时免密链接、生成朋友 48 小时临时房主授权链接。
- 玩家打开房主生成的玩家链接，不需要输入密码，直接加入当前牌局并可操作计数；链接 24 小时后过期。
- 房主关闭本局后，玩家链接不能继续进入或操作。
- 朋友打开 48 小时授权链接，会成为临时房主，可以邀请其他好友；授权期内可以重复开多局，但不会获得房主登录密码。

## 本地预览

在项目目录启动静态服务器：

```bash
python -m http.server 5173
```

然后打开：

```text
http://localhost:5173
```

如果没有配置 Supabase，页面会退回本机计数模式，不能多人实时同步。

## Supabase 配置

1. 在 Supabase SQL Editor 运行 `supabase-schema.sql`。
2. 部署 `supabase/functions/room-auth/index.ts` 到 Edge Function，函数名为 `room-auth`。
3. 在 Edge Function Secrets 里设置：

```text
OWNER_SETUP_PASSWORD=你的登录密码
SUPABASE_SERVICE_ROLE_KEY=你的 Supabase secret/service role key
```

4. 在 `config.js` 填入：

```js
window.POKER_COUNTER_CONFIG = {
  supabaseUrl: "https://你的项目.supabase.co",
  supabaseAnonKey: "你的 publishable 或 anon key",
  roomAuthFunctionUrl: ""
};
```

登录密码不要写进 GitHub 文件；它只应该存在 Supabase Secrets 里。
