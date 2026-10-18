# Voice Interaction（全双工实时语音点单）

可以单独跑（自带演示页），也可以作为依赖装进任何店铺网站。

## 🌟 核心特性：全双工语音交互

- **自动端点检测（Auto-Endpointing）**：浏览器里跑 Silero VAD（ONNX，@ricky0123/vad-web），自动判断顾客什么时候开始、什么时候说完，说完就发送，不用按键。
- **智能打断（Barge-in）**：AI 播报回复时，顾客一开口，浏览器立刻停止播放，服务器取消这一轮还在进行的识别/大模型/语音合成请求。
- **轮次号（turn id）机制**：每句话一个编号，每个阶段（ASR → LLM → TTS → 播放）都会检查"这一轮是否已取消"，取消的就丢掉。
- **边想边说**：大模型一边输出，一边按句号/问号断句（超过 26 个字遇到逗号也断），每句马上送去合成并按顺序播放，第一句话很快就能听到。
- **说一半停顿不会被当成两句**：如果上一轮被打断时 AI 还没说话、也没改购物车，它的内容会和下一句拼起来（"一杯珍珠奶茶……少冰" 还是一句）。
- **听、想、说分开**：浏览器负责"听"和"说"（麦克风、VAD、播放），服务器负责"想"（识别、点单、合成），中间用一条 WebSocket。

## 🧋 核心特性：点单

- **菜单就是知识库**：菜单（饮品、甜度/冰量等选项、小料、价格、售罄）直接放进提示词，小店用不着向量数据库。
- **AI 用工具改购物车**：`add_to_cart` / `update_cart_line` / `remove_cart_line`，参数用菜单 id 做枚举，服务器再校验一次（售罄、不存在的选项、数量上限都会被拒绝）。
- **不会乱报价、不会下单**：价格由代码算，AI 不能改价、不能打折、不能付款；结账永远由顾客自己点。
- **识别提示**：把菜单名称作为语音识别的 prompt，"芋泥波波""杨枝甘露"更容易识别对。
- **中英双语**：顾客说哪种语言就用哪种回答。
- **没有 key 也能跑**：不设 `OPENAI_API_KEY` 时自动进入演示模式（打字点单、关键词识别、浏览器朗读）。
- **防刷**：只允许同域页面连接，每个连接每分钟最多 20 轮，全站每天默认最多 3000 轮。

## 📁 项目关键结构

| 文件 | 作用 |
|---|---|
| `audio_interaction.js` | 核心：`VoiceAssistantController`，每个顾客连接一个。轮次管理、打断取消、ASR → 点单 → 逐句 TTS、分阶段日志 |
| `public/audio_client.js` | 浏览器端：`VoiceAssistantClient`。麦克风 + Silero VAD 自动断句、按顺序播放、打断、文字输入 |
| `order_agent.js` | 点单"大脑"：提示词（菜单 + 当前购物车）、工具定义、大模型 ⇄ 工具循环 |
| `menu_store.js` | 菜单校验、购物车行、价格计算、显示名称 |
| `sentence_splitter.js` | 流式回复断句 |
| `config_data.js` | 全局配置：采样率、静音时长、阈值、模型名、限流等 |
| `providers/openai.js` | OpenAI：语音识别、流式对话 + 工具、语音合成（纯 fetch，无 SDK） |
| `providers/mock.js` | 演示模式：不用 key，关键词识别菜单 |
| `index.js` | 对外入口：`createVoiceServer()`（WebSocket + 浏览器文件） |
| `app_order.js` / `app_order.html` | 演示应用：左边栏"开启全双工语音交互"、购物车、菜单；右边对话 |
| `data/menu.json` | 演示菜单 |
| `test/`、`e2e/` | 单元/集成测试，浏览器端到端测试 |

关键参数（都在 `config_data.js`）：16kHz 单声道、32ms 一帧、静音 500ms 算说完、短于 250ms 丢弃、单句最长 12 秒。

## 🛠️ 安装与运行

需要 Node.js 20+。

```bash
npm install
cp .env.example .env      # 填 OPENAI_API_KEY；不填就是演示模式
npm start                 # http://localhost:8787
```

打开页面，在左边栏点 **"▶️ 开启全双工语音交互"**，允许麦克风，直接说"两杯珍珠奶茶，一杯少冰"。AI 回答的时候插一句"换成燕麦奶"，试试打断。

加 `?debug` 可以在浏览器控制台看到 `[VAD] [PLAYBACK] [BARGE_IN]` 日志；服务器终端会打印 `[ASR] [LLM] [TOOL] [TTS] [TURN]` 日志。

## 🔌 接入自己的网站

```bash
npm install github:mitchee30/voice-interaction
```

（`package-lock.json` 会锁住装到的那个提交；想升级时再执行一次这条命令。）

服务器（Express 示例）：

```js
const { createVoiceServer } = require('voice-interaction');

const voice = createVoiceServer({
  shopName: 'My Tea Shop',
  getMenu: () => buildVoiceMenu(), // 把店里的菜单转换成 data/menu.json 的格式（价格用"分"）
});
app.use(voice.assets());   // 提供 /voice/audio_client.js
voice.attach(httpServer);  // WebSocket 在 /voice/ws
```

> 如果网站自己已经有 WebSocket（比如 `new WebSocketServer({ server })`），要把它改成 `noServer` 并按路径分流，否则会抢走 `/voice/ws` 的连接。

浏览器：

```js
import { VoiceAssistantClient } from '/voice/audio_client.js';

const client = new VoiceAssistantClient({
  getCart: () => cartLines,          // [{id, itemId, qty, options, addons, note}]
  onCart: (op) => applyToCart(op),   // {op:'add'|'update', line} | {op:'remove', lineId}
  onUserSpeech: (text) => ...,
  onAssistantReplyChunk: (turn, text) => ...,
  onStateChange: (state) => ...,     // off/connecting/idle/hearing/thinking/speaking
});
micButton.onclick = () => client.start();  // 必须在点击里调用（iPhone 要求）
// 顾客手动改了购物车之后：client.syncCart()
```

VAD 文件默认从 jsDelivr 加载（固定版本 vad-web 0.0.30 / onnxruntime-web 1.22.0），只在顾客点麦克风时下载。

## ⚙️ 配置

都在 `config_data.js`，模型相关可以用环境变量覆盖（见 `.env.example`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | 无 | 不设就是演示模式 |
| `OPENAI_CHAT_MODEL` | `gpt-4.1-mini` | 点单对话 |
| `OPENAI_ASR_MODEL` | `gpt-transcribe` | 语音识别 |
| `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE` | `gpt-4o-mini-tts` / `marin` | 语音合成 |
| `OPENAI_BASE_URL` | OpenAI | 任何 OpenAI 兼容接口（对话部分） |
| `VOICE_MAX_TURNS_PER_DAY` | `3000` | 全站每天最多多少轮，0 = 不限 |

## ⚠️ 注意事项

- **必须 HTTPS**：浏览器只在 HTTPS（或 localhost）下给麦克风权限。
- **回声**：浏览器开了回声消除，AI 说话时 VAD 阈值也会调高；但笔记本外放时仍可能被自己的声音打断，用耳机最稳。手机一般没问题。
- **模型会下线**：OpenAI 公布 `gpt-4.1-mini`、`gpt-4o-mini-tts` 计划在 2027 年初下线，到时候改环境变量换新模型即可，代码不用动。
- **费用**：每一轮会调用一次识别、一到两次对话、每句一次合成，按量计费；上线前在 OpenAI 后台设好每月上限。
- **语音合成**的声音对中文有口音，中文为主的店以后可以加阿里云 CosyVoice 适配（`providers/` 里加一个文件）。

## 🧪 测试

```bash
npm test            # 单元 + 集成测试（假的 OpenAI 服务器，不花钱）
npm run test:e2e    # 真 Chromium + 真 VAD + 假麦克风：自动断句、打断、改购物车、手机宽度
```

## 📄 许可证

暂未设置（默认保留所有权利）。
