# 项目协作约定

## 功能文档同步

用户要求开发过程中持续维护 Word 功能介绍。

- 新增、修改、删除用户功能或改变接入状态时，同步更新 `docs/FEATURES.md` 的正文、日期、文档版本和版本记录。
- 使用 `tools/build-feature-doc.py`（Python 3 + python-docx）重新生成根目录 `项目功能介绍.docx`，检查生成结果与页面排版。正文以 Markdown 为准，不只修改生成后的 Word。
- 生成命令为 `python tools/build-feature-doc.py`；优先使用文档技能提供的运行环境。Windows 本机 Word 可用时，`tools/preview-feature-doc.py` 可通过独立后台实例生成预览，依赖 pywin32 和 Pillow，输出位于 `.local/doc-preview/`。
- 区分已实现、仅后端、未启用、待验证与尚未实现；以当前代码和实测为准，不把规划写成已完成。
- 运行、环境、Key 配置、手机连接或换机流程变化时，同步 `RUNBOOK.md`。
- 文档、脚本、临时文件与输出都保存在项目内，不记录真实 Key、令牌和个人数据。
- 若当前环境缺少文档生成或渲染能力，仍先更新正文，并明确报告 Word 或排版检查尚未同步完成；不要声称自动后台持续更新。
