# 月面叙事 · Lunar Narrative

lusion.co/about 的月面 hero 长镜头复刻版，独立工程（Vue 3 + Vite）。

## 运行

```bash
cd lunar-narrative
npm install
npm run dev
```

浏览器打开终端输出的地址（默认 http://localhost:5173）。

> three 与官方 examples 仍走本地 `vendor/three`（通过 Vite alias 映射），无需联网。

## 目录

```
index.html              Vite 入口
vite.config.js          Vue 插件 + three 别名（vendor）
src/main.js             createApp 入口
src/App.vue             页面骨架 + Three.js 生命周期（onMounted / onUnmounted）
src/styles.css          页面样式
src/effects/
  AboutExperience.js    相机样条 / 光照 / 地形 / 后期编排
  AboutHeroParticles.js 粒子星云 + 64³ 体积光照场
  AboutHeroHud.js       线框地形 / 字母层 / 点云人像
  GoalBloom.js          自定义泛光
  FinalPass.js          调色 / 颗粒 / 暗角
  SmaaPass.js           SMAA 抗锯齿
  FsrPass.js            超分收尾
src/core/BufLoader.js   Lusion 私有 .buf 模型解析器
vendor/three/           three 0.187（含 examples/jsm）
public/assets/          月面地形 / 岩石 / 贴图 / 团队点云
docs/                   复刻分析文档
```

## 交互

滚动即推进镜头：0 → 5.25 屏宽走完相机样条，5.25 → 6.125 屏宽是 HUD 转场。按住鼠标进入子弹时间，移动鼠标带动镜头偏移。

## 说明

代码基于 lusion.co/about 的公开 bundle 逆向复刻，仅供学习交流，素材版权归原作者所有。
