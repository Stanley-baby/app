# 仓库指南

## 项目结构与模块组织

```text
src/
├── routes/                    页面：登录、收藏、设置、扩展
├── co/                        可复用 UI 组件
├── data/                      Redux actions、reducers、sagas、API
├── modules/                   浏览器、存储、翻译等工具
├── assets/                    图标、语言包和静态资源
└── target/extension/          扩展专属代码
    ├── background/            快捷键、菜单、地址栏搜索、高亮
    └── manifest/              MV3 清单生成器
build/                         Webpack 配置
dist/chrome/{dev,prod}/        Chrome 生成产物；Git 忽略
```

共享 Web 应用入口是 `src/index.js`。改动扩展行为时优先从
`src/target/extension/` 开始；改动页面或收藏数据流时查看 `routes/`、`co/` 和 `data/`。

## 构建、测试与开发命令

项目目标为 Node 18.16.0。本机使用 Homebrew 时，为每条命令临时选择 Node 18：

```bash
PATH="$(brew --prefix node@18)/bin:$PATH" npm i
PATH="$(brew --prefix node@18)/bin:$PATH" npm run local:extension:chrome
```

`local:extension:chrome` 会监听源码并写入 `dist/chrome/dev`；在
`chrome://extensions` 加载该目录，重新构建后点击“重新加载”。其他常用命令：

- `npm run local`：启动 Web 应用。
- `npm run build:extension:chrome`：生成 `dist/chrome/prod` 和 Chrome ZIP 包。
- `npm run build`：构建生产版 Web 应用。
- `npm run size:extension:chrome`：生成 Chrome 扩展体积报告。

仓库没有已提交的测试套件或 `npm test` 脚本；每项改动都应完成对应生产构建，并在
浏览器中手工验证受影响流程。

## 代码风格与命名

遵循相邻模块的格式；现有 JavaScript 通常使用四空格缩进和单引号。ESLint 基于
`eslint:recommended`，并启用 React 与 React Hooks 规则；修改文件时处理其中的
错误和警告。功能目录保持小写，例如 `routes/extension/`；文件名使用描述性的
小写或 kebab-case，例如 `fix-safari-profile-cookies.js`。优先使用 `~data`、
`~target`、`~config` 等现有别名。

## 提交与 Pull Request

提交标题保持简短、祈使语气，例如 `Fix Safari extension long URL handling`；每次
提交只聚焦一个变更。Pull Request 应说明目标浏览器、用户可见变化、关联 Issue
（如有）、构建与手工验证结果；UI 改动附截图。保持 `dist/`、`node_modules/` 和
凭据文件不进入提交。

## Agent skills

### Issue tracker

Issues live in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout. See `docs/agents/domain.md`.
