---
name: code-review
description: 对给定 Git 仓库的指定分支/提交范围执行代码评审,产出结构化的评审报告。
---

# 代码评审 Skill(占位)

此文件为骨架阶段的占位。后续从 CLI 版本搬入完整的 skill 定义。

实际使用时,有两种部署方式(详见设计文档"Skill 复用"):
- 方案 A:commit 到目标仓库,SDK 通过 `settingSources: ["project"]` 自动识别。
- 方案 B:沙箱镜像里预置,启动时写入工作目录的 `.claude/skills/`。
