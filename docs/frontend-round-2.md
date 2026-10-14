# RELVYK 第二轮前端升级

本轮沿用暖白、石墨、钴蓝与原机械几何，新增机械入场/跳过入口及真实选中状态、结构导览、Assembly / Exploded / Trace、连续拆解、SVG 2D 聚焦、扩展工作台、双向流程蓝图、可暂停与逐步选择的回放、两个来源明确的历史案例、三类任务能力档案，以及分层证据抽屉。没有修改 RPC 协议、任务引擎、钱包权限、CA 或 ticker；没有推广到生产。

浏览器已点测：导览前进/关闭且任务保持 Awaiting input；部件点击与聚焦、真实 viewBox 缩放、复位、键盘拆解 50%；蓝图 VERIFY 联动；扩展/退出/Esc；历史案例进入、Play/Pause、前后步骤与拖动至 REMEMBER；回放前后本地记录数量保持 5；检查选中后精确显示 result.raw.transaction.meta.err；抽屉关闭；Reflex 搜索/展开检查/清除；复制 JSON 成功反馈；一次真实 Devnet 查询完成且用户选中的 Verification gauge 保持。1440、1920、390 布局未出现文档横向溢出。

124 项自动测试全部通过，lint、类型检查、构建与内联脚本语法检查通过。独立纯悬停及系统减少动态效果没有单独浏览器实测，已有模拟指针/媒体/可见性测试覆盖；案例只是已有真实记录的回放，不计作实时查询或新执行。

关键文件：app.js、app.css、index.html、src/model-controller.js、src/engine-blueprint.js、src/experience-ui.js、src/replay-controller.js、src/recorded-examples.js、src/reflex-dossiers.js、src/evidence-panel.js。

截图：

- [修改前首屏](screenshots/round-2/before-overview.jpg) / [修改后首屏](screenshots/round-2/after-overview.jpg)
- [修改前工作台](screenshots/round-2/before-engine.jpg) / [装配视图](screenshots/round-2/after-engine-assembly.jpg)
- [拆解视图](screenshots/round-2/after-engine-exploded.jpg) / [扩展工作台](screenshots/round-2/after-expanded-workspace.jpg)
- [证据抽屉](screenshots/round-2/after-evidence-drawer.jpg) / [1920 桌面](screenshots/round-2/after-engine-1920.jpg) / [390 窄屏](screenshots/round-2/after-mobile-engine.jpg)

最终 Preview：[打开机械工作台](https://resnomo-replica-cl54g9163-zs2.vercel.app/#engine)。Vercel READY，仍为既有项目 Preview，未覆盖生产。最终页面已实际打开并点测 Expand / Exit；从可见入口退出后滚动位置差为 0。最终截图见 [上线工作台](screenshots/round-2/after-final-preview.jpg)。
