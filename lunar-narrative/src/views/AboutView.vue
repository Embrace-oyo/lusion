<template>
  <div class="page">
    <!-- 滚动行程：u = scrollY / innerWidth，限制到 u = 4（陨坑全景），后续 HUD 段落不进入 -->
    <div class="track"></div>

    <div class="stage">
      <div ref="hostEl" class="host"></div>

      <div ref="introEl" class="intro">
        <!-- WebGL 标题锚点：原站 #about-who-title-main-logo 的 rect -->
        <div ref="logoEl" class="intro-logo"></div>
        <div class="intro-scroll">SCROLL TO EXPLORE</div>
      </div>

      <div class="crosses">
        <span>+</span><span>+</span><span>+</span><span>+</span><span>+</span>
      </div>
    </div>
  </div>
</template>

<script setup>
// Vue 生命周期钩子 + 模板 ref：用于在组件挂载/卸载时接管 WebGL 体验
import { onBeforeUnmount, onMounted, ref } from 'vue';
// about 页的整场 WebGL 编排（相机样条 / 月面 / 粒子 / HUD 全在这一个类里）
import { AboutExperience } from '../effects/AboutExperience.js';
// 页面首帧渲染完成后的就绪信号，供全局加载遮罩收尾
import { markPageReady } from '../core/pageReady.js';

// WebGL canvas 的挂载容器（对应模板里的 ref="hostEl" 的 .host）
const hostEl = ref(null);
// 首屏标题/滚动提示所在层，JS 会用它去查 .intro-scroll 做淡出
const introEl = ref(null);
// 标题锚点元素：每帧把它的 getBoundingClientRect 喂给 LOGO 着色器
const logoEl = ref(null);

// 体验实例引用；生命周期外保持可空，避免卸载后仍被访问
let experience = null;

// 组件挂载：创建体验、挂到容器上，并把它暴露的两个 DOM 元素一并传入
onMounted(() => {
  // 每进入一次页面都新建实例（内部自行创建 renderer / 资源 / 事件监听）
  experience = new AboutExperience();
  // mount 是异步的（要等全部 buf / 贴图加载完），成功后打就绪标记
  experience
    // hostEl.value 是真实 DOM 容器；introEl/logoEl 供 DOM 联动与 logo rect 使用
    .mount(hostEl.value, { introEl: introEl.value, logoEl: logoEl.value })
    // 资源全部就绪后再通知外部（例如隐藏 loading）
    .then(markPageReady)
    // 即使加载失败也要解除 loading，避免页面卡在遮罩上
    .catch(() => markPageReady());
});

// 组件卸载前：释放 GPU 资源并移除事件监听，防止泄漏
onBeforeUnmount(() => {
  // dispose 内部会取消 RAF、移除 scroll/resize/pointer 监听、dispose 全部几何与材质
  experience?.dispose();
  // 置空引用，杜绝悬空实例
  experience = null;
});
</script>

<style scoped>
.page {
  position: relative;
  background: #000;
}

/* 最大滚动 = 4 × 视口宽（再减掉一屏视口高，得到 u 上限 = 4） */
.track {
  height: calc(400vw + 100vh);
  pointer-events: none;
}

.stage {
  position: fixed;
  inset: 0;
  overflow: hidden;
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  color: #fff;
}

.host {
  position: absolute;
  inset: 0;
}

.host :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

/* ── 首屏大标题锚点 + 滚动提示 ── */
.intro {
  position: fixed;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}

/* 原站 #about-who-title-main-logo：1280×800 下 left 64 / top 515.4 / 1152×231.5 */
.intro-logo {
  position: absolute;
  left: 5vw;
  top: 64.4vh;
  width: 90vw;
  height: 18.1vw;
}

/* 原站 #about-who-title-main-scroll：left 982.6 / top 750 / 235.8×45.1 */
.intro-scroll {
  position: absolute;
  right: 4.8vw;
  top: 93.7vh;
  font-size: clamp(13px, 1.91vw, 26px);
  line-height: 1;
  letter-spacing: 0.06em;
  font-weight: 500;
  will-change: transform, opacity;
}

/* ── 十字标记 ── */
.crosses {
  position: fixed;
  left: 0;
  right: 0;
  top: 50%;
  z-index: 5;
  display: flex;
  justify-content: space-between;
  padding: 0 46px;
  color: rgba(255, 255, 255, 0.45);
  font-size: 15px;
  pointer-events: none;
  opacity: 0;
}
</style>
