<template>
  <AboutView />
  <div v-if="bootVisible" class="boot" :class="{ hidden: bootHidden }">LOADING</div>
</template>

<script setup>
// 独立项目入口：不再有路由，根组件直接渲染月面叙事页面
import { onMounted, ref } from 'vue';
import AboutView from './views/AboutView.vue';
import { waitPageReady } from './core/pageReady.js';

// 首帧前的黑场遮罩：AboutView 的体验 mount 完成后调用 markPageReady 揭幕
const bootVisible = ref(true);
const bootHidden = ref(false);

onMounted(async () => {
  // 超时兜底：资源异常时也不会一直卡在黑屏
  await waitPageReady(15000);
  bootHidden.value = true;
  setTimeout(() => {
    bootVisible.value = false;
  }, 900);
});
</script>

<style scoped>
.boot {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  background: #000;
  font-size: 12px;
  letter-spacing: 0.3em;
  color: rgba(255, 255, 255, 0.55);
  transition: opacity 0.8s ease;
}

.boot.hidden {
  opacity: 0;
  pointer-events: none;
}
</style>
