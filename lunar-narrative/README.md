# 月面叙事 · Lunar Narrative

lusion.co/about 的月面 hero 长镜头复刻版，独立工程（Vue 3 + Vite + Three.js）。

## 运行

```bash
cd lunar-narrative
npm install
npm run dev
```

浏览器打开终端输出的地址（默认 http://localhost:5173），启动后直接进入月面叙事页面。

生产构建：

```bash
npm run build
npm run preview
```

> three 走 npm 依赖（锁定 0.187），后处理示例来自 `three/examples/jsm`，无需额外包。

## 目录

```
index.html              Vite 入口
vite.config.js          Vue 插件
src/main.js             createApp 入口（关闭 THREE.ColorManagement，与原站一致）
src/App.vue             根组件：直接渲染 AboutView + 首帧 LOADING 遮罩
src/styles.css          全局样式
src/views/AboutView.vue 页面骨架（滚动行程 / 标题锚点 / Vue 生命周期）
src/effects/
  AboutExperience.js    相机样条 / 光照 / 地形 / 后期编排
  AboutHeroParticles.js 粒子星云 + 64³ 体积光照场
  AboutHeroHud.js       线框地形 / 字母层 / 点云人像
  GoalBloom.js          自定义泛光（FFT，逐级清洗 NaN/Inf）
  FinalPass.js          调色 / 颗粒 / 暗角
  SmaaPass.js           SMAA 抗锯齿
  FsrPass.js            超分收尾
src/core/BufLoader.js   Lusion 私有 .buf 模型解析器
src/core/pageReady.js   资源就绪信号（首帧遮罩收尾）
public/assets/          月面地形 / 岩石 / 贴图 / 字体 / 团队点云
```

## 交互

滚动即推进镜头：`u = scrollY / innerWidth`，本工程行程到 `u = 4`（陨坑全景），后续 HUD 段落不进入。按住鼠标进入子弹时间（粒子与光照场减速到 10%），移动鼠标带动镜头偏移。

## 说明

代码基于 lusion.co/about 的公开 bundle 逆向复刻，仅供学习交流，素材版权归原作者所有。配套教程见 `掘金-月面长镜头特效教程.md`。
