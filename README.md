# Lusion 特效复刻 · 教程合集

这里是 [Lusion](https://lusion.co) 网站特效的复刻教程合集。每个子目录都是一个**独立可运行**的最小工程，配一篇掘金文章，把原站的实现拆开讲透。

作者：**西伯利亚小火龙**。

## 教程列表

| 教程 | 掘金文章 | 目录 | 技术要点 |
| --- | --- | --- | --- |
| 气球物理特效 | 《22 个气球，怎样互相映照：拆解 Lusion 主页的气球特效》 | [balloons-tutorial](./balloons-tutorial/) | 向心重力 + 强阻尼、两两碰撞、鼠标「射线管」推挤、三根胶囊求 AO/阴影/反射、matcap 三通道 |
| 屏幕流体特效 | 《我以为是流体解算，结果只是一张贴图：复刻 Lusion 的屏幕流体特效》 | [fluid-screen-tutorial](./fluid-screen-tutorial/) | 四通道速度场、半拉格朗日平流、9 次偏移采样折射、色散条纹 |

## 怎么跑

每个子目录都是独立的工程，各自进目录执行：

```bash
cd <子目录>
npm install
npm run dev
```

打开终端提示的地址（默认 `http://localhost:5173`）即可看到效果。

- **气球**：移动鼠标推挤气球，点击画面切换配色
- **流体**：移动鼠标搅动画面，右上角 lil-gui 面板可调参数

> 需要 WebGL2，建议用桌面版 Chrome / Edge / Safari。

## 目录结构

```
lusion/
├── balloons-tutorial/        # 气球物理特效（Three.js + 原生 JS + Vite）
│   ├── 掘金-气球物理特效教程.md
│   └── src/ ...
└── fluid-screen-tutorial/    # 屏幕流体特效（Three.js + 原生 JS + Vite）
    ├── 掘金-屏幕流体特效教程.md
    └── src/ ...
```

每个教程的正文、配图、目录结构说明都在各自的 `README.md` 里，想深入细节直接进对应目录。

## 说明

所有效果均来自 [Lusion](https://lusion.co)，本仓库仅用于学习与图形学交流。模型、贴图与视觉设计的版权归原作者所有，请勿用于商业用途。