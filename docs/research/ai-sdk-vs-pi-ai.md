# 可行性:用 @ai-sdk/openai-compatible 替换 pi-ai 作为 LLM Provider

> 研究日期:2026-08-14。来源:DSH 源码(dsh-src)、MiMo-Code 仓库(XiaomiMiMo/MiMo-Code)、
> npm 包类型(@ai-sdk/openai-compatible@2.0.41 实际 tarball)。
> 问题背景:pi-ai 模态门禁只有 text/image → 音频无法走 DSH 原生 LLM 管道;MiMo-Code 用
> ai-sdk 且音频是一等媒体。问:换 ai-sdk 是否可行?

## 结论(一句话)

**不该"替换"pi-ai,该"新增"ai-sdk 适配器;而真正的堵点不是 provider 库,是 DSH 的内容模型
(`ContentBlockMap` 没有 audio 块)——换库只是必要条件,不是充分条件。**

## 事实

### @ai-sdk/openai-compatible@2.0.41(npm 类型实测)

- **`input_audio` 是一等 part**:`{type:"input_audio", input_audio:{data(base64), format:"wav"|"mp3"}}`
- FilePart 的 `mediaType` 以 `audio/` 开头 → 自动映射为 input_audio;`application/pdf` → file part;`image/*` → image_url
- 音频 part 只吃**本地 base64**(URL 音频抛 `UnsupportedFunctionalityError`)
- MiMo-Code 给 ai-sdk 打的 patch 是**工具流式修复**(tool-call JSON 缓冲),与音频无关——音频是原生能力

### DSH 的 LLM adapter 缝

- `LlmAdapter` 子类 + `ctx.llm.registerAdapter(['provider-route'], adapter)`——**插件可注册新适配器,pi-ai 不需要被替换**(deepseek 直连适配器 `dsh-llm-deepseek` 就是先例)
- 契约:`GenerateOptions.provider` 选适配器;错误两条路径(LlmError / finish error);honor signal

### 真正的堵点(DSH 内容模型)

- `ContentBlockMap` = text / reasoning / image / tool-call / tool-result——**无 audio 块**
- 适配器序列化的是 **DSH 内容块**;没有 audio 块,就没有东西可变成 input_audio
- 块映射 **merge-extensible**(插件可声明 `'audio': AudioBlock`),但 DSH 官方要求"新核心块
  必须同步 adapter/UI/compaction 支持"——UI 对未知块的渲染、会话 compact 对未知块的保留,
  是实现期的**验证风险项**(未验证,非结论)

## 完整原生音频路径 = 一个插件包

1. 声明 `'audio'` ContentBlock(merge-extensible)
2. `read_audio` 工具(镜像 `read_image`:workspace 路径 → attachment 服务 → audio 块),或 composer 音频上传
3. ai-sdk 适配器(dsh-llm-ai-sdk):audio 块 → input_audio part
4. 验证项:UI fallthrough、compact 保留、多轮 replay、provider 路由与 pi-ai 并存

## 收益 vs 风险

| 收益 | 风险/成本 |
|---|---|
| 音频进 DSH 原生管道 → agent 直接"听到"(同 MiMo-Code),免工具中介 + 手动上下文 | 比"工具中介 + 上下文引导"(#11)重一个量级 |
| 视频/PDF 同路径白得(ai-sdk file part) | DSH 核心配合:块声明在插件侧,但 compact/UI 兼容需实测 |
| 不动 pi-ai,生态零破坏(新增适配器) | 双适配器并存需确认 provider 路由不冲突 |

## 建议路径

1. **短期**:先做 #11(工具中介 + 上下文注入,零风险,已排票)
2. **中期**:原生音频立项前先做 SPIKE——验证 a) 会话 UI 对未知块是否安全 fallthrough;
   b) 会话 compact 是否保留未知块;c) 插件声明的块能否流经模型请求到适配器。
   SPIKE 通过再决定插件实现,不过则维持工具中介
