# RELVYK 升级交付与验收

交付日期：2026-10-14。链上观察时间统一为 UTC。本报告汇总实际完成的代码、浏览器检查和部署结果，区分实时查询、真实响应回放与 mock 测试。

## 实际修改

- 在原有静态 HTML/CSS/JavaScript 项目上升级，保留等距 SVG 六部件解剖、机械引擎展示、选择、拆解、复位与键盘操作；采用暖白、石墨、钴蓝及少量深薄荷绿，重新组织 Overview、Inspect、Engine、Reflexes、Evidence、Docs。
- 建立唯一任务状态：INPUT → SENSE → PLAN → AUTHORIZE → EXECUTE → VERIFY → REMEMBER。阶段、模型反馈、检查与记录使用同一来源；查询完成即显示结果，取消与新输入使过期响应失效。
- 实现真实只读交易解析、Mint 属性/权限/Token-2022 扩展读取、账户快照及同账户同网络比较。保留原始响应、未知字段、失败原因与整数精度；交易失败与解析任务完成分别记录。
- 实现三个实际 Reflex 模板、参数副本、搜索/筛选、真实运行计数及版本隔离。Transaction 检查版本为 `1.1.0`，支持 legacy/v0/v1 及 v1 签名资源配置检查；Mint 和 Snapshot 模板为 `1.0.0`。
- 实现 IndexedDB 证据、步骤回放、JSON 导出、记录删除及关联快照删除。回放不产生新查询或执行次数。存储不可用时明确使用页面会话内存。
- 实现 Wallet Standard 发现、连接状态和可取消的页面会话观察队列。普通查询不需要钱包或签名，不发送资金交易。清理复制来源的开发者经历、宣传链接及未经确认的项目 CA，保留第三方许可。

## 真实接口与浏览器结果

以下为实际本地浏览器通过真实 RPC 完成的只读查询，地址均是验收样本，**不是 RELVYK 项目 Mint**。

| 样本 | 网络/结果 |
| --- | --- |
| legacy 交易 `5TWqTumm…gs5SfPJS` | Devnet，slot `510983971`，解析完成。 |
| v0 交易 `2f8FEwP4…b9iamcz` | Devnet，slot `510983995`，版本化账户及指令解析完成。 |
| v1 失败交易 `2iKX75nD…SoVb1Ld` | Mainnet Beta，slot `456844515`，finalized；链上错误为 Instruction 0 / Custom 12，解析任务完成，未将链上交易显示为成功。 |
| 原始 Token Program Mint `Aj1…` | Supply `1501030000`，decimals `6`；Mint Authority 确认存在，Freeze Authority 确认已撤销。 |
| Token-2022 Mint `7mqdwH6yrbUZcx4jKomAYG2A6mEnuf4hdH5yt4XM14gv` | 本次浏览器观察 Supply `747018364.316342795`；读取到扩展类型 `18/3/19`，展示范围与限制。供应量随观察时间可能变化。 |
| Native SOL Mint `So11111111111111111111111111111111111111112` | Mint/Freeze Authority 均确认已撤销。 |
| 钱包地址 `AVm…` | 判定为非 Mint；未把缺失权限字段解释为已撤销。 |
| 不匹配网络的交易查询 | RPC 返回 null；显示来源未返回记录，未声称交易从未存在。 |
| 同账户 `AVm…` 两次 Devnet 快照 | 真实观察时间 `2026-10-14T12:56:43.472Z` 和 `2026-10-14T13:02:56.396Z`；SOL 变化 `-11.427290083`，本次 Token 查询返回空集合；未将差额称为利润，也未宣称覆盖完整资产组合。 |

已部署 Preview 还通过其原生 `/api/rpc` 完成两次独立真实浏览器查询：

- Devnet legacy：观察于 `2026-10-14T13:20:52.537Z`。完整签名、来源、检查、时间线和原始依据见 [live-preview-transaction.json](evidence/live-preview-transaction.json)。
- Mainnet v1 失败交易：观察于 `2026-10-14T13:26:22.796Z`，finalized，错误保持 Instruction 0 / Custom 12。完整依据见 [live-preview-mainnet-v1.json](evidence/live-preview-mainnet-v1.json)。

真实浏览器检查还覆盖：首页 CTA 聚焦实际输入框、导航及 Docs 返回、模型键盘选择/拆解/复位、结果 Tab 键盘操作、IndexedDB 恢复、复制反馈和 JSON 导出。Preview 保存参数副本后显示 0 次运行，实际 Run 后为 1 次；Replay 后记录数量仍为 2；删除弹窗的 Keep record 正常关闭。

## 自动测试、工程检查及明确限制

最终 **106 项自动测试全部通过**：6 项回放已捕获的真实 RPC 响应，97 项使用 mock/合成数据，3 项检查纯 UI 的导出/URL/日期边界。真实响应及捕获时间记录在 `tests/fixtures/solana/provenance.json`；回放不是新的实时查询。

ESLint、CheckJS/TypeScript 类型检查及生产构建均退出码 0。发布客户端为 31 个白名单文件，私密路径、测试、环境配置、旧 CA 与密钥匹配数为 0；原生 RPC Function 为 7.87 KB。不存在关闭检查、删除测试或随机生成实时数据的做法。

以下项目仅通过 mock/合成测试，未宣称真实钱包或链上实测：钱包连接/拒绝/断开/切换账户、多钱包发现、真正删除记录、超时/限流/缓存过期/过期输入、本地存储不可用/配额异常、重复观察事件与队列。浏览器未检测到兼容钱包，因此没有真实钱包签名；减少动态效果通过 mock 检查，未修改用户操作系统设置。

当前项目 Mint 为 null，项目观察 feature 为 false；没有运行真实项目代币事件监控。持币门槛与认证云工作区关闭，无持续后台运行、收益承诺、买卖、托管或主网资金操作。

## 配置与关键文件

- `src/config.js`：统一品牌与功能；`tokenConfig.mint/ticker/tradeUrl` 当前均为 null。确认项目 CA 后，只在此处设置已确认 Mint、网络及有效链接；如需有限会话观察，再明确开启 `features.projectTokenObserver`。持币及认证能力仍需真实服务边界。
- `.env.example`：可选服务器专用 `SOLANA_MAINNET_RPC_URL`、`SOLANA_DEVNET_RPC_URL`、`SOLANA_TESTNET_RPC_URL`。默认公共 RPC 已通过真实查询，核心功能无需额外密钥；托管 RPC 可用于改善配额和可用性，密钥不得暴露前端。
- 界面与模型：`index.html`、`app.css`、`app.js`、`docs.html`、`model.css`、`src/model-controller.js`、`src/result-view.js`、`src/ui-helpers.js`、`figures/verification-engine.html`。
- 功能与数据：`src/task-engine.js`、`src/evidence-store.js`、`src/reflex-library.js`、`src/solana/`、`src/wallet-service.js`、`src/session-observer.js`、`src/observation-queue.js`、`api/rpc.js`。
- 工程：`package.json`、锁文件、`eslint.config.js`、`tsconfig.json`、`scripts/build.mjs`、`serve.mjs`、`vercel.json`、`tests/`。基线审查见 [site-audit.md](site-audit.md)。

## 截图与 Preview

1440px、1920px、390px 已检查，无横向溢出。截图包括 [1440 首页](screenshots/after-1440.jpg)、[1920 首页](screenshots/after-1920.jpg)、[1440 工作台](screenshots/after-workbench-1440.jpg)、[1920 工作台](screenshots/after-workbench-1920.jpg)、[窄屏首页](screenshots/after-mobile.jpg)、[窄屏工作台](screenshots/after-mobile-workbench.jpg)、[内容](screenshots/after-content.jpg)、[底部](screenshots/after-footer.jpg)、[Docs](screenshots/after-docs.jpg)、[真实 mainnet v1 查询](screenshots/after-live-mainnet-v1.jpg)。修改前截图保留在同一目录。

可访问 Preview：<https://resnomo-replica-8p8k3n3f3-zs2.vercel.app/>。部署到既有 `zs2/resnomo-replica`，Deployment `dpl_9v7qkjEMbsPCxhyUTdrGo2zC4YRn` 为 READY，target 明确为 Preview。未推广生产域名，未更改归属或 DNS。本报告和源码压缩包是部署后的交付材料，没有因报告或新头像再部署。

源码包 `resnomo-solana-upgrade.zip` 包含源码、测试、许可、截图和验收证据；排除 `.git`、`node_modules`、构建目录 `public`、`.vercel`、真实 `.env*`、日志、work 和凭据，保留空白 `.env.example`。后续生成的头像是独立素材，不写入现有网站，也不纳入此源码包。
