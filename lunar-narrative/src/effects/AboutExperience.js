/**
 * AboutExperience.js — lusion.co/about 月面 hero 复刻
 *
 * 逆向依据（bundle 偏移）：
 *   AboutHero        @1026200  相机样条 + 编排
 *   AboutHeroLight   @940189   光源 + 1024x2048 光照阴影图
 *   AboutHeroScatter @962469   胶囊光源线积分散射（光柱）
 *   AboutHeroGround  @985073   陨石坑地形 + 地面阴影累积
 *   AboutHeroHalo    @1007981  远景散射盒（光晕）
 *
 * 滚动编排（AboutWhoSection @1053614）：
 *   u = scrollY / viewportWidth
 *   initialSplineRatio = fit(u, 0, 5.25, 0, 1)      相机沿样条推进（149/200 段）
 *   introRatio         = u / 5.25                   场景淡入 / 散射强度
 *   hudRatio           = fit(u, 5.25, 6.125, 0, 1)  首屏 HUD 退场
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { GoalBloomPass } from './GoalBloom.js';
// 原站全局 PostEffect 队列的收尾段：Final / Smaa / Fsr
import { FinalPass } from './FinalPass.js';
import { SmaaPass } from './SmaaPass.js';
import { FsrPass } from './FsrPass.js';
import { AboutHeroParticles, LF_SLICE } from './AboutHeroParticles.js';
import { AboutHeroHud } from './AboutHeroHud.js';
import { loadBuf } from '../core/BufLoader.js';

/* ───────────────────────── 数学 ───────────────────────── */

// 钳制到 0..1（与 GLSL saturate 等价），滚动编排里所有比例都靠它收口
const saturate = (v) => Math.min(1, Math.max(0, v));
// 线性插值：t=0 取 a，t=1 取 b（用于两段 fit 结果之间的拼接）
const mix = (a, b, t) => a + (b - a) * t;
// 区间映射：把 x∈[a,b] 线性映到 [c,d] 并钳制；a===b 时直接返回 c（防除零）
const fit = (x, a, b, c, d) => (a === b ? c : c + (d - c) * saturate((x - a) / (b - a)));
// 常用缓动曲线（数值写法与原站 bundle 一致，便于逐帧对齐）
const ease = {
  // 三次缓出：起步快、收尾慢（用于场景淡入 sceneRatio）
  cubicOut: (t) => 1 - Math.pow(1 - t, 3),
  // 三次缓入：起步慢、收尾快（用于散射强度衰减）
  cubicIn: (t) => t * t * t,
  // 正弦缓入缓出：两端导数为 0（用于相机 dolly 的 FOV 偏移）
  sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
};

/* ───────────────────────── Shader chunks ───────────────────────── */

// 光源阴影图的采样 uv 计算（原站 chunk: getLightUv）
// 阴影图不是普通相机投影，而是一张「以光源为中心、上下两个半球的极坐标展开图」：
// 上半球占 uv.y ∈ [0.5,1]，下半球占 [0,0.5]，这样一张 1024×2048 贴图即可覆盖全向。
const GET_LIGHT_UV = /* glsl */ `
uniform vec2 u_lightShadowTextureTexelSize;
vec2 getLightUv(vec3 lightToWorld) {
  // 把 y 压扁 1.5 倍：让水平方向的信息更占主导，接近原站的「扁平穹顶」映射
  float flatYScale = 1.5;
  // 归一化后取 xz 平面，得到极坐标方向
  vec2 flatUv = normalize(lightToWorld * vec3(1.0, flatYScale, 1.0)).xz;
  // 取分量绝对值，用于把方向「方形化」到 [-1,1]² 的边界
  vec2 dir = abs(normalize(flatUv));
  // 除以较大分量 → 投影到正方形边界，再映射到 [0,1]，y 再压到半个贴图高度
  flatUv = (flatUv * (dir.y > dir.x ? 1.0 / dir.y : 1.0 / dir.x) * 0.5 + 0.5) * vec2(1.0, 0.5);
  // 判断点是否在光源上方（决定用上半张还是下半张贴图）
  float isTop = lightToWorld.y > 0.0 ? 1.0 : 0.0;
  // 半个纹素高度：把 y 钳在贴图内侧，避免采样越界到另一半
  float halfTexelY = u_lightShadowTextureTexelSize.y * 0.5;
  // 钳制 uv.y：上半球限制下界、下半球限制上界
  flatUv.y = clamp(0.0 + isTop * halfTexelY, 0.5 - (1.0 - isTop) * halfTexelY, flatUv.y);
  // 上半球整体平移 0.5，落到贴图上半部分
  return flatUv + vec2(0.0, isTop * 0.5);
}
`;

/* 光源阴影图（原站 lightShadowMapFrag）：存到光源的距离，作为地面软阴影输入 */
// 岩石的 shadow 通道用 ROCKS 的 IS_SHADOW 分支写 v_distToLight，
// 这里把它原样写进贴图（距离已归一化到 0..1，地面 pass 再和自身距离比较得出遮挡）。
const LIGHT_SHADOW_FRAG = /* glsl */ `
// 该片元到光源的距离（已在顶点里除以 u_lightShadowMaxDistance）
varying float v_distToLight;
void main() {
  // 存入 r 通道，其它通道无意义
  gl_FragColor = vec4(v_distToLight);
}
`;

/* 地面软阴影累积（原站 AboutHeroGround 的 frag$b，8-tap） */
const GROUND_SHADOW_FRAG = /* glsl */ `
// 上一帧的地面阴影（时间累积，避免闪烁）
uniform sampler2D u_prevTexture;
// 岩石投到光源方向的深度图
uniform sampler2D u_lightShadowTexture;
// 光源世界位置
uniform vec3 u_lightPosition;
// 每帧随机的蓝噪声偏移（打散 8-tap 的规则采样）
uniform vec2 u_blueNoiseOffset;
// 阴影图里距离的最大值（用于把 world 距离归一化到 0..1）
uniform float u_lightShadowMaxDistance;
// 地面阴影覆盖的半径（世界单位）
uniform float u_radius;
// 一个像素的 uv 尺寸
uniform float u_texelSize;
varying vec2 v_uv;

// 极坐标阴影图 uv
#include <getLightUv>
// 蓝噪声
#include <getBlueNoise>

// 与 step 不同，linearStep 在区间内线性过渡
float linearStep(float edge0, float edge1, float x) { return clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0); }

void main() {
  // 蓝噪声采样（带随机偏移 → 每次 tap 的抖动方向不同）
  vec3 blueNoise = getBlueNoise(gl_FragCoord.xy + u_blueNoiseOffset);
  // 从 uv 中心指向该像素的方向（用于把地面 uv 转成世界坐标）
  vec2 uvDir = normalize(v_uv - 0.5);
  // 沿径向内缩一个纹素，抵消极坐标展开的拉伸
  vec2 uv = v_uv - uvDir * u_texelSize;
  // uv [-1,1] → 地面圆盘世界坐标（xzy 重排让 uv.y 对应世界 z）
  vec3 worldPosition = vec3(uv * 2.0 - 1.0, 0.0).xzy * u_radius;
  // z 取反，修正坐标手性
  worldPosition.z *= -1.0;
  // 地面点 → 光源向量
  vec3 lightToWorld = worldPosition - u_lightPosition;
  // 到光源的距离
  float distToLight = length(lightToWorld);
  // 距离光源越远，阴影越软：0 = 近（硬阴影），1 = 远（大幅抖动）
  float expandRatio = linearStep(u_lightPosition.y, 14.0, distToLight);
  // 每个 tap 的步进：水平方向按 expandRatio 放大并加蓝噪声抖动，
  // 再除以采样数，保证 8 次采样覆盖同一段区间（软阴影的半影展开）
  vec3 lightSampleStep = ((vec3(lightToWorld.x, 0.0, lightToWorld.z) * (1.0 - expandRatio * 0.75) + (blueNoise - 0.5) * expandRatio * 4.0) * 25.0 * expandRatio * expandRatio) / float(LIGHT_SHADOW_SAMPLE_COUNT) * -mix(0.06, 0.1, expandRatio);
  // 采样起点加上蓝噪声偏移，避免所有像素步进完全一致（条纹）
  vec3 lightToWorldPos = lightToWorld + lightSampleStep * blueNoise.y;
  // 遮挡累积值
  float accum = 0.0;
  // 8-tap（LIGHT_SHADOW_SAMPLE_COUNT 由 JS 的 defines 注入）沿光源方向步进
  for (int i = 0; i < LIGHT_SHADOW_SAMPLE_COUNT; i++) {
    // 该采样点的自身距离（归一化）
    float selfDist = min(1.0, length(lightToWorldPos) / u_lightShadowMaxDistance);
    // 投到光源阴影图上的 uv
    vec2 lightShadowUv = getLightUv(lightToWorldPos);
    // 读岩石在光源方向上的最近距离
    float dist = texture2D(u_lightShadowTexture, lightShadowUv).r;
    // 自身距离比遮挡物更远 → 说明这段被挡
    float delta = selfDist - dist;
    // 被挡时按 delta² 软化（20 倍放大对比），否则记为完全受光 1.0
    accum += delta > 0.0 ? min(delta * delta * 20.0, 1.0) : 1.0;
    // 前进一个采样步
    lightToWorldPos += lightSampleStep;
  }
  // 平均得到 0..1 的阴影掩码
  float shadowMask = accum / float(LIGHT_SHADOW_SAMPLE_COUNT);
  // 越远越趋于无阴影，避免远处出现硬边
  shadowMask = mix(shadowMask, 1.0, expandRatio);
  // 6 次幂压暗过渡区：让「全亮/全暗」的面积更大、半影更窄
  shadowMask = pow(shadowMask, 6.0);
  // 上一帧结果
  float prevShadowMask = texture2D(u_prevTexture, v_uv).r;
  // 时间累积：变暗（出现新阴影）用 0.5 权重，变亮（阴影消失）用 0.2 权重
  // → 阴影出现快、消失慢，形成柔和的拖影
  gl_FragColor = vec4(mix(prevShadowMask, shadowMask, shadowMask > prevShadowMask ? 0.5 : 0.2));
}
`;

/* 岩石：原站 vert$8 / frag$c 逐字移植（烘焙 16 片 × 120 帧动画贴图） */
const ROCK_VERT = /* glsl */ `
// 岩石被切成 16 块（piece 0..15），每块有自己的烘焙位置/朝向
attribute float piece;
// 实例编号（4 种模型 × 64 实例，用来做逐实例随机）
attribute float instanceId;
// 逐实例随机数：x=时间偏移 y=出现阈值 z=半径/旋转 w=整体尺度
attribute vec4 instanceRands;
// 烘焙动画位置贴图（16 列 × 120 帧，RGBA：xyz + piece 随机）
uniform sampler2D u_posRandTexture;
// 烘焙动画朝向贴图（四元数）
uniform sampler2D u_orientTexture;
// 动画贴图尺寸（16, 120），用于把帧号换算成 uv
uniform vec2 u_animationTextureSize;
// 循环动画时间（受子弹时间影响）
uniform float u_time;
// 全局时间（不受子弹时间影响，用于轻微漂浮）
uniform float u_globalTime;
// 整体缩放（入场时从 0 长到 1）
uniform float u_scale;
// 噪波稳定因子（与粒子共享，控制漂浮幅度）
uniform float u_noiseStableFactor;
// HUD 阶段退场比例（1 = 完全隐藏）
uniform float u_hudRatio;

// 阴影 pass：只需要到光源的距离
#ifdef IS_SHADOW
// 光源位置
uniform vec3 u_lightPosition;
// 距离归一化上限
uniform float u_lightShadowMaxDistance;
// 输出给片元
varying float v_distToLight;
// 极坐标阴影 uv
#include <getLightUv>
// 正常 pass：输出世界坐标/法线/uv/深度给片元
#else
// 世界坐标（用于散射与光照）
varying vec3 v_worldPosition;
// 视图空间法线
varying vec3 v_viewNormal;
// 主贴图 uv
varying vec2 v_uv;
// 线性深度（0 近 1 远），写进 g 通道
varying float v_depth;
#endif

// 线性区间过渡（比 step 更柔和）
float linearStep(float edge0, float edge1, float x) { return clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0); }
// 四元数旋转向量：v + 2·q.xyz×(q.xyz×v + q.w·v)
vec3 qrotate(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
// 由轴 + 半角构造四元数
vec4 quaternion(vec3 axis, float halfAngle) { return vec4(axis * sin(halfAngle), cos(halfAngle)); }
// 4 维哈希：输入 2D 坐标输出 4 个 0..1 随机数（逐实例/逐周期的确定性随机）
vec4 hash42(vec2 p) {
  // 拼接 + 小数化，打散输入
  vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  // 与自身点积混合
  p4 += dot(p4, p4.wzxy + 33.33);
  // 再乘回并取小数，得到 4 个分量
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}
// 2D 旋转（角度制），用于实例的环绕角度
vec2 rotate(vec2 v, float a) { float s = sin(a); float c = cos(a); mat2 m = mat2(c, s, -s, c); return m * v; }

void main() {
  // 一个完整循环：0.25s 出现 + 2s 停留 + 4s 上升 = 6.25s
  float duration = 0.25 + 2.0 + 4.0;
  // 每个实例错开相位（instanceRands.x ∈ 0..1）
  float time = duration * instanceRands.x + u_time;
  // 第几个循环（用于每轮重新抽半径/角度）
  float cycle = floor(time / duration);
  // 循环内时间
  time = time - duration * cycle;
  // 本轮循环的随机数（cycle + instanceId 保证确定性）
  vec4 cycleRands = hash42(vec2(cycle, instanceId));
  // 上升比例：2.25s 之后开始，pow 1.5 让起步更缓、后段更快
  float flyUpRatio = pow(linearStep(2.25, 6.25, time), 1.5);
  // 出现比例：0.25s 内按 instanceRands.y 错峰弹出；HUD 阶段整体压到 0
  float appearRatio = linearStep(0.0, 0.25, time - instanceRands.y) * (1.0 - u_hudRatio);
  // 自旋四元数：轴随机、半角随 flyUpRatio 增长到 5~30 弧度（飞出时剧烈翻滚）
  vec4 selfSpin = quaternion(normalize(instanceRands.xyz - 0.5), flyUpRatio * mix(5.0, 30.0, cycleRands.z));
  // 碎片缩放 = 出现比例（从 0 长出来）
  float pieceScale = appearRatio;
  // 旋转中心：地面上方 1.9 ~ 2.3
  vec3 origin = vec3(0.0, 1.9 + instanceRands.w * 0.4, 0.0);
  // 环绕角度：每轮随机 0..2π
  float angle = cycleRands.x * 6.2832;
  // 环绕半径：4 ~ 8
  float radius = 4.0 + cycleRands.w * 4.0;
  // 滚动收拢比例：前 3.25s 内从 1 衰减到 0（岩石先聚拢再上升）
  float rollRatio = 1.0 - linearStep(0.0, 3.25, time + instanceRands.x);
  // 收拢时半径减小最多 5（rollRatio² 让收拢更急速）
  radius -= (rollRatio * rollRatio) * 5.0;
  // 环绕方向的单位向量
  vec2 dir = vec2(cos(angle), sin(angle));
  // 实例偏移：水平按半径绕圈，垂直按 flyUpRatio 上升到 30~40，
  // 再叠加噪波稳定因子驱动的轻微漂浮（sin 相位按 instanceId 错开）
  vec3 instanceOffset = vec3(
    dir.x * radius,
    flyUpRatio * mix(30.0, 40.0, cycleRands.z) + u_noiseStableFactor * (0.5 + 0.5 * sin(u_globalTime + instanceId * 0.1)) * 0.1,
    dir.y * radius
  );
  // 水平方向再自转（flyUpRatio² 加速），并乘 smoothstep 让起飞瞬间平滑收拢
  instanceOffset.xz = rotate(instanceOffset.xz, flyUpRatio * flyUpRatio * mix(-1.0, 1.0, instanceRands.z)) * smoothstep(1.5, 0.35, flyUpRatio);

  // 动画帧号：0.25~2.25s 之间从第 0 帧走到第 119 帧
  float frame = linearStep(0.25, 2.25, time) * 119.0;
  // 当前帧（向下取整）
  float frameFloor = floor(frame);
  // 下一帧（不越过 119）
  float frameCeil = min(frameFloor + 1.0, 119.0);
  // 两帧之间的插值权重
  float frameFract = frame - frameFloor;
  // 把 (piece, frameFloor, frameCeil) 组装成两组 uv（xy = 当前帧，zw = 下一帧）
  vec4 simUvs = (vec3(piece, frameFloor, frameCeil).xyxz + 0.5) / u_animationTextureSize.xyxy;
  // 当前帧的位置 + piece 随机数
  vec4 posRand1 = texture2D(u_posRandTexture, simUvs.xy);
  // 当前帧的朝向
  vec4 orient1 = texture2D(u_orientTexture, simUvs.xy);
  // 下一帧的位置
  vec4 posRand2 = texture2D(u_posRandTexture, simUvs.zw);
  // 下一帧的朝向
  vec4 orient2 = texture2D(u_orientTexture, simUvs.zw);

// 阴影 pass 把碎片放大 1.5 倍，让软阴影更明显（原站同做法）
#ifdef IS_SHADOW
  // 放大碎片
  pieceScale *= 1.5;
#endif

  // 当前帧：旋转 + 缩放 + 平移
  vec3 pos1 = qrotate(orient1, position) * pieceScale + posRand1.xyz;
  // 下一帧同理
  vec3 pos2 = qrotate(orient2, position) * pieceScale + posRand2.xyz;
  // 最终位置：
  //   u_scale*0.75              —— 全局入场缩放
  //   mix(.5,1.5,rand²)         —— 逐实例大小差异
  //   linearStep(1,.9,flyUp)    —— 起飞初期快速缩小到 0（远离镜头）
  //   qrotate(selfSpin, ...)    —— 绕 origin 自旋
  //   mix(.3,.7,cycleRands.w)   —— 每轮整体尺寸变化
  //   + instanceOffset          —— 环绕 + 上升
  vec3 pos = u_scale * 0.75 * mix(0.5, 1.5, instanceRands.z * instanceRands.z)
    * linearStep(1.0, 0.9, flyUpRatio)
    * (qrotate(selfSpin, mix(pos1, pos2, frameFract) - origin) + origin)
    * mix(0.3, 0.7, cycleRands.w)
    + instanceOffset;

// 阴影 pass 用极坐标投影直接写裁剪空间
#ifdef IS_SHADOW
  // 实例中心（用于判断在光源上方还是下方）
  vec3 center = instanceOffset + origin - u_lightPosition;
  // 转到以光源为原点
  pos -= u_lightPosition;
  // 归一化距离写进 varying
  v_distToLight = length(pos) / u_lightShadowMaxDistance;
  // 把点压到 y=±0.001 的薄层里，避免贴在光源平面上的自遮挡
  if (center.y > 0.0) { pos.y = max(0.001, pos.y); } else { pos.y = min(-0.001, pos.y); }
  // 用极坐标 uv 生成裁剪坐标，z 存距离（配合深度测试得到最近遮挡）
  gl_Position = vec4(getLightUv(pos) * 2.0 - 1.0, 1.0 - v_distToLight, 1.0);
// 正常 pass：输出法线与深度
#else
  // 当前帧法线（先按烘焙朝向转，再叠加自旋）
  vec3 nor1 = qrotate(selfSpin, qrotate(orient1, normal));
  // 下一帧法线
  vec3 nor2 = qrotate(selfSpin, qrotate(orient2, normal));
  // 两帧法线按同一权重插值后归一化
  vec3 nor = normalize(mix(nor1, nor2, frameFract));
  // 标准 MVP 投影
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  // 世界坐标（散射/光照用）
  v_worldPosition = (modelMatrix * vec4(pos, 1.0)).xyz;
  // 视图空间法线（片元里再转到世界空间）
  v_viewNormal = normalMatrix * nor;
  // 主贴图 uv
  v_uv = uv;
  // 线性深度：near=1 / far=100，与其它材质保持同一编码
  v_depth = 1.0 - ((modelViewMatrix * vec4(pos, 1.0)).z + 1.0) / (1.0 - 100.0);
#endif
}
`;

const ROCK_FRAG = /* glsl */ `
// 打包后的岩石贴图（RGB = 4 种岩石的四象限灰度，A 未用）
uniform sampler2D u_texture;
// 通道选择器：当前岩石类型对应哪一个通道（one-hot 权重）
uniform vec4 u_textureChannelMixer;
// 原站保留的光照颜色（本移植未参与计算）
uniform vec3 u_lightColor;
// 光源世界位置（点光源，按距离平方衰减）
uniform vec3 u_lightPosition;
// 噪波稳定因子：影响衰减系数与高光强度（与粒子同源）
uniform float u_noiseStableFactor;
// 场景可见比例（入场淡入）
uniform float u_sceneRatio;
// 世界坐标（散射积分需要用）
varying vec3 v_worldPosition;
// 视图空间法线
varying vec3 v_viewNormal;
// 贴图 uv
varying vec2 v_uv;
// 线性深度
varying float v_depth;

// 线性过渡
float linearStep(float edge0, float edge1, float x) { return clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0); }
// 方向向量从视图空间转世界空间（只取旋转部分，不做平移）
vec3 inverseTransformDirection(in vec3 dir, in mat4 matrix) { return normalize((vec4(dir, 0.0) * matrix).xyz); }

// 胶囊光源散射（光柱），见 GET_SCATTER
#include <getScatter>

void main() {
  // 用 one-hot 通道选择器挑出当前岩石的灰度图案
  float pattern = dot(u_textureChannelMixer, texture2D(u_texture, v_uv));
  // 视图空间法线归一化
  vec3 viewNormal = normalize(v_viewNormal);
  // 转到世界空间
  vec3 worldNormal = inverseTransformDirection(viewNormal, viewMatrix);
  // 表面 → 光源向量
  vec3 worldToLight = u_lightPosition - v_worldPosition;
  // 距离（用于衰减）
  float worldToLightDist = length(worldToLight);
  // 点光源衰减：1/(0.05 + (0.02 - 0.005*noise)*d²)，噪波稳定因子越大衰减越慢
  float attenutation = 1.0 / (0.05 + (0.02 - 0.005 * u_noiseStableFactor) * worldToLightDist * worldToLightDist);
  // 归一化成方向
  worldToLight /= worldToLightDist;
  // 相机 → 表面方向（反射向量要用）
  vec3 cameraToWorld = normalize(v_worldPosition - cameraPosition);
  // 半兰伯特漫反射：0.25 起步，避免背面全黑
  float diff = 0.25 + 0.75 * dot(worldNormal, worldToLight);
  // 高光：反射方向与光线方向的点积 × 0.8
  float spec = 0.8 * dot(reflect(cameraToWorld, worldNormal), worldToLight);
  // 基础颜色 = 贴图灰度
  vec3 color = vec3(pattern);
  // 叠加衰减与「环境光 0.05 + 漫反射 + 高光×漫反射」
  color *= attenutation * (0.05 + diff + spec * diff);
  // 原站编码：r=照明 g=深度 b=1 a=高光遮罩（alpha 决定泛光范围）
  gl_FragColor = vec4(color * 0.85 + 0.15, spec * (0.3 + u_noiseStableFactor));
  // 叠加来自胶囊光源的散射（岩石逆光时的轮廓光）
  gl_FragColor.rgb += vec3(getScatter(cameraPosition, v_worldPosition));
  // g 通道写线性深度（HUD 径向模糊与雾都要用）
  gl_FragColor.g = v_depth;
  // b 通道固定 1（原站用来做「表面标记」）
  gl_FragColor.b = 1.0;
}
`;

/* 宇航员：原站 vert$6 / frag$9（54 骨骼，双骨蒙皮，骨骼位姿由 CPU 每帧 lerp/slerp 写入 uniform） */
const PERSON_VERT = /* glsl */ `
// 两个影响该顶点的骨骼索引（每顶点最多两根骨）
attribute vec2 boneIndices;
// 对应两根骨的权重（和为 1）
attribute vec2 boneWeights;
// 骨骼位置（每根骨一个 vec3），由 _updatePerson 每帧写入
uniform vec3 u_bonePoses[BONE_COUNT];
// 骨骼朝向（四元数），同样每帧写入
uniform vec4 u_boneOrients[BONE_COUNT];
// 世界坐标（散射/光照）
varying vec3 v_worldPosition;
// 世界法线
varying vec3 v_worldNormal;
// 贴图 uv
varying vec2 v_uv;
// 线性深度
varying float v_depth;

// 方向向量视图→世界
vec3 inverseTransformDirection(in vec3 dir, in mat4 matrix) { return normalize((vec4(dir, 0.0) * matrix).xyz); }
// 四元数旋转
vec3 qrotate(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

void main() {
  // 累加后的蒙皮位置
  vec3 pos = vec3(0.0);
  // 累加后的蒙皮法线
  vec3 nor = vec3(0.0);
  // 第一根骨的偏移
  vec3 bonePos = u_bonePoses[int(boneIndices.x)];
  // 第一根骨的朝向
  vec4 boneOrient = u_boneOrients[int(boneIndices.x)];
  // 第一根骨贡献：旋转本地位置再平移，按权重加权
  pos += (qrotate(boneOrient, position) + bonePos) * boneWeights.x;
  // 法线同样按权重累加
  nor += qrotate(boneOrient, normal) * boneWeights.x;
  // 第二根骨
  bonePos = u_bonePoses[int(boneIndices.y)];
  // 第二根骨朝向
  boneOrient = u_boneOrients[int(boneIndices.y)];
  // 第二根骨的位置贡献
  pos += (qrotate(boneOrient, position) + bonePos) * boneWeights.y;
  // 第二根骨的法线贡献
  nor += qrotate(boneOrient, normal) * boneWeights.y;
  // 视图空间位置（投影与深度都要用）
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  // 标准投影
  gl_Position = projectionMatrix * mvPosition;
  // 世界坐标
  v_worldPosition = (modelMatrix * vec4(pos, 1.0)).xyz;
  // 视图空间法线转世界
  v_worldNormal = inverseTransformDirection(nor, viewMatrix);
  // 贴图 uv
  v_uv = uv;
  // 线性深度编码（near 1 / far 100，与地形一致）
  v_depth = 1.0 - ((modelViewMatrix * vec4(pos, 1.0)).z + 1.0) / (1.0 - 100.0);
}
`;

const PERSON_FRAG = /* glsl */ `
// 合并后的贴图：rgb = person_light 三相位光照，a = person 的明暗遮罩
uniform sampler2D u_texture;
// 光源位置（保留 uniform，本移植未直接用于逐像素计算）
uniform vec3 u_lightPosition;
// 三相位光照混合权重（r/g/b 对应动画三段）
uniform vec3 u_lightMixer;
// 场景可见比例
uniform float u_sceneRatio;
// HUD 退场比例
uniform float u_hudRatio;
// 世界坐标（散射）
varying vec3 v_worldPosition;
// 世界法线
varying vec3 v_worldNormal;
// 贴图 uv
varying vec2 v_uv;
// 线性深度
varying float v_depth;

// 胶囊光源散射
#include <getScatter>

void main() {
  // 法线归一化（本移植未直接使用，保留原站计算）
  vec3 worldNormal = normalize(v_worldNormal);
  // 采样合并贴图
  vec4 map = texture2D(u_texture, v_uv);
  // 三个光照相位按 u_lightMixer 加权混合
  float light = dot(u_lightMixer, map.rgb);
  // 1.25 次幂压暗中间调，让亮部更集中（原站同参数）
  light = pow(light, 1.25);
  // 基础明暗来自 alpha（person.webp 的遮罩）
  float baseShade = map.a;
  // 原站：人物不参与泛光（alpha = 0），r=照明 g=深度 b=1
  gl_FragColor = vec4(vec3(baseShade * light), 0.0);
  // 叠加逆光散射（人物边缘的轮廓光）
  gl_FragColor.rgb += vec3(getScatter(cameraPosition, v_worldPosition));
  // 深度写 g
  gl_FragColor.g = v_depth;
  // b 固定 1
  gl_FragColor.b = 1.0;
  // r 乘场景比例并随 HUD 阶段淡出
  gl_FragColor.r *= u_sceneRatio * (1.0 - u_hudRatio);
}
`;

// 地面人物投影的顶点：普通 MVP 投影，只透传 uv
const PERSON_SHADOW_VERT = /* glsl */ `
// 贴图 uv
varying vec2 v_uv;
void main() {
  // 透传 uv
  v_uv = uv;
  // 标准投影（面片已旋转平铺在地面上）
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// 地面人物投影的片元：用三相位光照算出一个 0.7~1.0 的乘法遮罩，
// 再以「dst * src」的乘法混合压在地面上（见 _buildPerson 的 CustomBlending 设置）。
const PERSON_SHADOW_FRAG = /* glsl */ `
// 人物光照贴图（三相位 rgb）
uniform sampler2D u_texture;
// 三相位混合权重
uniform vec3 u_lightMixer;
// 投影面片 uv
varying vec2 v_uv;
// 蓝噪声
#include <getBlueNoise>
void main() {
  // 蓝噪声（偏移 (3,36) 与其它材质错开，避免图案重合）
  vec3 blueNoises = getBlueNoise(gl_FragCoord.xy + vec2(3.0, 36.0));
  // 采样光照三通道
  vec3 map3 = texture2D(u_texture, v_uv).xyz;
  // 正常相位混合
  float light1 = dot(u_lightMixer, map3);
  // 通道轮换混合（gbr）：让阴影的明暗过渡更随机
  float light2 = dot(u_lightMixer.gbr, map3);
  // 按蓝噪声在两个结果间插值（消除条带）
  float light = mix(light1, light2, blueNoises.x);
  // 平方后压到 0.7~1.0：阴影最深也只压 30% 亮度
  light = light * light * 0.3 + 0.7;
  // r 是乘法因子；g/b 无意义；a=0 不参与 alpha 累积
  gl_FragColor = vec4(light, 1.0, 1.0, 0.0);
}
`;

/* person_light.rgb + person.r(alpha) 通道合并（原站 textureHelper.mixChannels） */
// 一次离屏 pass 把两张图合成一张 RGBA：省一次采样，也让材质只用一张贴图
const MERGE_FRAG = /* glsl */ `
// 光照贴图（提供 rgb）
uniform sampler2D u_light;
// 明暗贴图（提供 r）
uniform sampler2D u_base;
// 全屏 uv
varying vec2 v_uv;
void main() {
  // rgb 取自光照图，alpha 取明暗图的红通道
  gl_FragColor = vec4(texture2D(u_light, v_uv).rgb, texture2D(u_base, v_uv).r);
}
`;

/* rocks.webp 四象限打包成 RGBA（原站 preInit 里的转换 pass） */
// 一次离屏 pass 把四张灰度岩石贴图塞进同一张 RGBA 图：4 种岩石 = 4 个通道，
// 岩石材质的 u_textureChannelMixer 就是在这个 pass 结果上做 one-hot 选择。
const PACK_FRAG = /* glsl */ `
// 原始四象限贴图
uniform sampler2D u_texture;
// 全屏 uv
varying vec2 v_uv;
void main() {
  // 把 uv 缩到左下象限（每个象限的相对坐标）
  vec2 uv = v_uv * 0.5;
  // r/g/b/a 分别取四个象限的绿通道（原站灰度存在 g 里）
  gl_FragColor = vec4(
    texture2D(u_texture, uv).g,
    texture2D(u_texture, uv + vec2(0.5, 0.0)).g,
    texture2D(u_texture, uv + vec2(0.0, 0.5)).g,
    texture2D(u_texture, uv + vec2(0.5, 0.5)).g
  );
}
`;

// 全屏后处理通用顶点：2×2 面片直接输出裁剪空间坐标，uv 透传给片元
const FULLSCREEN_VERT = /* glsl */ `
// 屏幕空间 uv
varying vec2 v_uv;
void main() {
  // 透传 uv
  v_uv = uv;
  // position.xy ∈ [-1,1] 正好是 NDC，z=0、w=1 保证不被裁剪
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// 胶囊光源散射（光柱）核心公式，逆向自原站 AboutHeroScatter @962469。
// 思路：把「线段光源」对当前像素的散射贡献解析积分出来（不是蒙特卡洛）：
//   getScatterCoff  —— 单个点光源沿射线的散射系数（用 atan 求解析积分）
//   getScatterLine  —— 把线段光源投影到射线上，求最近点参数 s，再调用上面的点光源公式
//   getScatter      —— 从相机到世界点做积分，再用 div / powInv 调整光柱的软硬
// 三个函数都被 #include <getScatter> 复用，所有地表/岩石/人物材质共享同一套光柱。
const GET_SCATTER = /* glsl */ `
// 光柱权重分母（x 近、y 远），控制光柱的空间衰减
uniform vec2 u_lightScatterDivider;
// 输出幂次倒数（<1 时提亮扩散，>1 时收紧）
uniform float u_lightScatterPowInv;
// 线段光源两端
uniform vec3 u_lightScatterPos0;
uniform vec3 u_lightScatterPos1;
// 总体强度（入场/退场时整体缩放）
uniform float u_lightScatterRatio;

// 点光源对「start→dir 射线、长度 d」的散射系数（解析积分）
float getScatterCoff(vec3 start, vec3 dir, vec3 lightPos, float d) {
  // 光源 → 射线起点
  vec3 q = start - lightPos;
  // 射线方向与 q 的点积（最近点参数）
  float b = dot(dir, q);
  // q 的平方长度
  float c = dot(q, q);
  // 垂直距离平方 t = c - b²
  float t = c - b * b;
  // 散射核：1/(2.5 + (0.001+t)^0.8)，t 越小越亮（贴近光轴处最强）
  float s = 1.0 / (2.5 + pow(0.001 + t, 0.8));
  // atan 形式的积分差：等价 ∫ 1/(t + x²) dx
  return s * (atan((d + b) * s) - atan(b * s));
}

// 线段光源版本：先把线段上离射线最近的点求出来，再退化成点光源
vec2 getScatterLine(vec3 start, vec3 dir, vec3 lightPos0, vec3 lightPos1, float d) {
  // 线段中点
  vec3 segCenter = (lightPos0 + lightPos1) * 0.5;
  // 线段方向（单位化）
  vec3 segDir = normalize(lightPos1 - lightPos0);
  // 射线起点相对线段中点
  vec3 diff = start - segCenter;
  // 线段半长
  float segExtent = distance(lightPos0, lightPos1) * 0.5;
  // 射线方向与线段方向的夹角余弦（取负）
  float a01 = -dot(dir, segDir);
  // 射线方向投影
  float b0 = dot(diff, dir);
  // 线段方向投影
  float b1 = -dot(diff, segDir);
  // 1 - cos² = sin²，作为解线性方程的分母
  float det = abs(1.0 - a01 * a01);
  // 最近点在线段上的参数 s（钳到 [-segExtent, segExtent]，避免除零）
  float s = clamp((a01 * b0 - b1) / max(0.0001, det), -segExtent, segExtent);
  // 最近点世界坐标
  vec3 lightPos = segDir * s + segCenter;
  // 用点光源公式算亮度（线段退化为点时用 lightPos0）
  float v = getScatterCoff(start, dir, segExtent > 0.0 ? lightPos : lightPos0, d);
  // y 分量：最近点在线段上的归一化位置（0..1），用于区分光柱上下段颜色
  return vec2(v, s / segExtent * 0.5 + 0.5);
}

// 对「相机 → 世界点」这条射线做散射积分
float getScatter(vec3 cameraPosition, vec3 worldPos, vec2 div, float powInv) {
  // 相机 → 世界点向量
  vec3 worldToCamera = worldPos - cameraPosition;
  // 距离（积分上限）
  float d = length(worldToCamera);
  // 积分方向
  vec3 dir = worldToCamera / d;
  // 线段光源贡献 + 归一化位置
  vec2 val = getScatterLine(cameraPosition, dir, u_lightScatterPos0, u_lightScatterPos1, d);
  // 按 div 做远近插值后取 powInv 次幂，再乘总强度
  return pow(max(0.0, val.x / mix(div.x, div.y, val.y)), powInv) * u_lightScatterRatio;
}

float getScatter(vec3 cameraPosition, vec3 worldPos) {
  return getScatter(cameraPosition, worldPos, u_lightScatterDivider, u_lightScatterPowInv);
}
`;

/* 原站 efxPrepass 的基础通道：r → 灰度，alpha 作泛光遮罩 */
// 场景里所有材质都把「照明」写在 r、把「深度」写在 g、把「泛光范围」写在 a，
// 这里只保留 r（灰度）与 a（遮罩），g/b 由后续后处理按需重建。
const PRE_EFX_FRAG = /* glsl */ `
// 屏幕 uv
varying vec2 v_uv;
// 上一步的渲染结果
uniform sampler2D u_texture;
void main() {
  // .rrra = rgb 都取 r 通道（灰度），alpha 原样保留
  gl_FragColor = texture2D(u_texture, v_uv).rrra;
}
`;

/* HUD 阶段的径向模糊（原站 blurFragmentShader）：用 b 通道（深度）控制强度 */
// 8 个方向 + 蓝噪声起始角，围绕当前像素做放射状采样；
// 深度越远（tex.b 越大）位移越大 → 中心清晰、边缘向外拉出速度线。
const HUD_BLUR_FRAG = /* glsl */ `
// 屏幕 uv
varying vec2 v_uv;
// 上一步结果
uniform sampler2D u_texture;
// 屏幕宽高比（保证径向采样是圆的而不是椭圆）
uniform float u_aspect;
// 模糊强度（= hudRatio）
uniform float u_blurRatio;

// 蓝噪声
#include <getBlueNoise>

void main() {
  // 每个像素用不同起始角，把 8 条采样线打散（避免明显的条纹）
  vec3 noise = getBlueNoise(gl_FragCoord.xy);
  // 原始像素
  vec4 tex = texture2D(u_texture, v_uv);
  // 采样累加（r=亮度，a=泛光遮罩）
  vec2 ra = vec2(0.0);
  // 采样序号（用于让每次采样的半径按 sqrt 均匀分布）
  float fi = 0.0;
  // 起始角：蓝噪声 × 2π
  float theta = noise.x * 6.283185307179586;
  // 位移强度：宽高比修正 × 0.006 基准 × 深度(b) × 模糊比例
  vec2 strength = vec2(1.0, u_aspect) * 0.006 * tex.b * u_blurRatio;
  // 8 次放射状采样
  for (int i = 0; i < 8; i++) {
    // 黄金角步进（10.166 弧度 ≈ 2π×1.618），让采样点绕圈均匀铺开
    theta += 10.166407384630519;
    // sqrt((fi+0.5)/8) 让采样半径在圆盘上均匀分布
    ra += texture2D(u_texture, v_uv + vec2(cos(theta), sin(theta)) * sqrt((fi + 0.5) / 8.0) * strength).ra;
    // 序号递增
    fi += 1.0;
  }
  // 平均
  ra /= 8.0;
  // 还原成 (灰度, 占位, 占位, 遮罩) 的编码，供 efx 调色使用
  gl_FragColor = ra.xxxy;
}
`;

// 运动模糊的实现要点：
//   u_motionTexture 是 1/4 分辨率的「屏幕速度图」（由粒子的 MOTION_VERT 写入），
//   xy = 编码后的速度方向（0.5 为中性），z = 强度；
//   这里沿速度方向做 16 次等距采样并取平均 = 定向模糊（不是模糊整屏）。
// u_blurRatio = 0 时 motion.xy 被乘成 0，退化成「采样 16 次同一像素」，
// 结果等价于 .rrra 预通道，所以三种 preEfx 材质可以互换使用。
/* 屏幕空间运动模糊（原站 motionBlurFragmentShader）：u_blurRatio=0 时等价于 .rrra 预通道 */const MOTION_BLUR_FRAG = /* glsl */ `
// 屏幕 uv
varying vec2 v_uv;
// 场景颜色
uniform sampler2D u_texture;
// 屏幕速度图
uniform sampler2D u_motionTexture;
// 模糊比例（入场时 1 → 1.5，之后归 0）
uniform float u_blurRatio;

// 蓝噪声
#include <getBlueNoise>

void main() {
  // 蓝噪声（偏移后使用，避免与其它 pass 共用同一组噪声相位）
  vec3 noise = getBlueNoise(gl_FragCoord.xy + vec2(41.0, 25.0));
  // 读取速度
  vec4 motion = texture2D(u_motionTexture, v_uv);
  // 解码：0..1 → -0.5..0.5
  motion.xy -= 0.5;
  // 速度 × 强度（motion.z-0.5）× 1/16 归一化 × 模糊比例 × 0.25 缩放
  motion.xy *= (motion.z - 0.5) / 16.0 * u_blurRatio * 0.25;
  // 采样累加
  vec4 c = vec4(0.0);
  // 起始偏移：速度 × 蓝噪声（让每条拖尾的起点错开，减少条带）
  vec2 offset = motion.xy * noise.xy;
  // 16 次等距采样
  for (int i = 0; i < 16; i++) {
    // 沿速度方向前进
    offset += motion.xy;
    // 累积采样
    c += texture2D(u_texture, v_uv + offset);
  }
  // 平均
  c /= 16.0;
  // 转成灰度 + 遮罩编码
  gl_FragColor = vec4(c.rrr, c.a);
  // 与原始像素比较
  vec4 color = texture2D(u_texture, v_uv).rrra;
  // 取较亮者：既保留拖尾，也保证原画面不被抹暗
  gl_FragColor = max(color, gl_FragColor);
}
`;

/* 原站 blur9：可分离 9-tap 高斯 */
// 运动模糊 RT 的降噪：水平一遍、垂直一遍；权重和恰为 1，不会改变整体亮度。
const BLUR9_FRAG = /* glsl */ `
// 输入（motion RT）
uniform sampler2D u_texture;
// 单步偏移（调用方按目标分辨率换算并逐 pass 换方向）
uniform vec2 u_delta;
// 屏幕 uv
varying vec2 v_uv;
void main() {
  // 中心采样权重 0.1633
  vec4 color = texture2D(u_texture, v_uv) * 0.1633;
  // 当前偏移
  vec2 delta = u_delta;
  // 第 1 圈（±1 步）
  color += texture2D(u_texture, v_uv - delta) * 0.1531;
  color += texture2D(u_texture, v_uv + delta) * 0.1531;
  // 步长翻倍
  delta += u_delta;
  // 第 2 圈（±2 步）
  color += texture2D(u_texture, v_uv - delta) * 0.12245;
  color += texture2D(u_texture, v_uv + delta) * 0.12245;
  // 步长翻倍
  delta += u_delta;
  // 第 3 圈（±3 步）
  color += texture2D(u_texture, v_uv - delta) * 0.0918;
  color += texture2D(u_texture, v_uv + delta) * 0.0918;
  // 步长翻倍
  delta += u_delta;
  // 第 4 圈（±4 步）
  color += texture2D(u_texture, v_uv - delta) * 0.051;
  color += texture2D(u_texture, v_uv + delta) * 0.051;
  // 输出加权平均
  gl_FragColor = color;
}
`;

/* AboutPageHeroEfx：colorBurn + colorDodge 双色调调色（原站 fragmentShader$1 逐字移植） */
// 调色思路（与原站一致）：先用 colorBurn 压出冷色阴影，再用 colorDodge 提亮，
// 两者按画面灰度 base 插值 —— 暗部偏 burn 色（#00f0ff），亮部偏 dodge 色（#005aff）。
const EFX_FRAG = /* glsl */ `
// 预通道结果（灰度 + 泛光遮罩）
uniform sampler2D u_texture;
// colorBurn 颜色与强度
uniform vec3 u_colorBurn;
uniform float u_colorBurnAlpha;
// colorDodge 颜色与强度
uniform vec3 u_colorDodge;
uniform float u_colorDodgeAlpha;
// 屏幕 uv
varying vec2 v_uv;

// colorDodge 混合：dst / (1 - src)，src=1 时置白（避免除零）
vec3 colorDodge(in vec3 src, in vec3 dst) {
  // step(0,src) 处理负值，max(1-src,1e-5) 防除零，dst≥1 时强制为 1
  return mix(step(0.0, src) * (min(vec3(1.0), dst / max(1.0 - src, 1e-5))), vec3(1.0), step(1.0, dst));
}
// colorBurn 混合：1 - (1 - dst) / src
vec3 colorBurn(in vec3 src, in vec3 dst) {
  // 同样做除零保护与上界钳制
  return mix(step(0.0, src) * (1.0 - min(vec3(1.0), (1.0 - dst) / max(src, 1e-5))), vec3(1.0), step(1.0, dst));
}

void main() {
  // 预通道像素
  vec4 texture = texture2D(u_texture, v_uv);
  // 预通道本应只保留灰度；取 r 并防 NaN/Inf（否则 NaN 会被 dodge 放大成纯蓝色斑块）
  float d = texture.r;
  // 非法值（负 / NaN）归 0，并钳到 1 以内
  d = d > 0.0 ? min(d, 1.0) : 0.0;
  // 灰度底
  vec3 base = vec3(d);
  // burn 结果按 alpha 混回灰度
  vec3 burned = mix(base, colorBurn(u_colorBurn, base), u_colorBurnAlpha);
  // dodge 结果按 alpha 混回灰度
  vec3 dodged = mix(base, colorDodge(u_colorDodge, base), u_colorDodgeAlpha);
  // 再用画面灰度在 burn 与 dodge 之间插值：暗部走 burn、亮部走 dodge
  texture.rgb = mix(burned, dodged, base);
  // 输出不透明
  gl_FragColor = vec4(texture.rgb, 1.0);
}
`;

// 蓝噪声采样工具（原站 chunk: getBlueNoise）
// LDR_RGB1_0.png 是一张 128×128 的 RGB 蓝噪声图（三个独立通道 = 三个随机数），
// 用 gl_FragCoord 平铺采样，offset 让不同材质用不同相位，避免图案互相重合。
const GET_BLUE_NOISE = /* glsl */ `uniform sampler2D u_blueNoiseTexture;
// 一个纹素的 uv（1/128）
uniform vec2 u_blueNoiseTexelSize;
// 每个材质自己的相位偏移（世界单位转 uv 后叠加）
uniform vec2 u_blueNoiseCoordOffset;
// 采样：坐标 × 纹素尺寸（平铺）+ 偏移
vec3 getBlueNoise(vec2 coord) {
  // 返回 rgb 三个独立的 0..1 随机数
  return texture2D(u_blueNoiseTexture, coord * u_blueNoiseTexelSize + u_blueNoiseCoordOffset).rgb;
}
`;

/* 地面：原站 groundVert / groundFrag 逐字移植（尾部把 r/g/b 通道编码改成灰度输出） */
const GROUND_VERT = /* glsl */ `
// 视图空间位置（法线扰动要用）
varying vec3 v_viewPosition;
// 世界坐标（光照 / 雾 / 散射）
varying vec3 v_worldPosition;
// 视图空间法线
varying vec3 v_viewNormal;
// 地形贴图 uv（terrain_shadow_light_height.webp）
varying vec2 v_uv;
// 模型本地坐标（岩石阴影图的平面投影用）
varying vec3 v_localPosition;
// 线性深度（写进 g 通道）
varying float v_depth;

void main() {
  // 视图空间位置
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  // 标准投影
  gl_Position = projectionMatrix * mvPosition;
  // 世界坐标
  v_worldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  // 视图法线（片元里再用 viewMatrix 转世界）
  v_viewNormal = normalMatrix * normal;
  // 视线方向（取负号：从表面指向相机）
  v_viewPosition = -mvPosition.xyz;
  // 贴图 uv
  v_uv = uv;
  // 本地坐标（用于把岩石阴影图对齐到地面）
  v_localPosition = position;
  // 原站 aboutHeroVisualFinal_vert：近处 1、远处 0
  float near = 1.0;
  // 远裁剪面
  float far = 100.0;
  // 线性深度归一化：z∈[-near,-far] → [1,0]
  v_depth = 1.0 - (mvPosition.z + near) / (near - far);
}
`;

const GROUND_FRAG = /* glsl */ `
// 视图空间位置
varying vec3 v_viewPosition;
// 世界坐标
varying vec3 v_worldPosition;
// 视图法线
varying vec3 v_viewNormal;
// 贴图 uv
varying vec2 v_uv;
// 本地坐标（岩石阴影投影）
varying vec3 v_localPosition;
// 线性深度
varying float v_depth;

// terrain_shadow_light_height.webp：r=烘焙阴影 g=烘焙光照 b=高度（法线扰动用）
uniform sampler2D u_texture;
// 岩石软阴影累积图（768×768）
uniform sampler2D u_groundShadowTexture;
// 地面基色
uniform vec3 u_color;
// 雾的目标色（= 背景色）
uniform vec3 u_bgColor;
// 光源位置
uniform vec3 u_lightPosition;
// 指数高度雾的两个系数
uniform float u_fogA;
uniform float u_fogB;
// 场景可见比例
uniform float u_sceneRatio;
// HUD 退场比例
uniform float u_hudRatio;
// HUD 出场比例（线条显影阶段地面压暗）
uniform float u_showRatio;
// 噪波稳定因子（影响点光衰减）
uniform float u_noiseStableFactor;

// 线性过渡
float linearStep(float edge0, float edge1, float x) { return clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0); }
// 方向向量视图→世界
vec3 inverseTransformDirection(in vec3 dir, in mat4 matrix) { return normalize((vec4(dir, 0.0) * matrix).xyz); }

// 指数高度雾：a/b 控制浓度与衰减高度，rayDir.y 参与积分（贴地雾更浓）
vec3 applyFog(in vec3 rgb, in float distance, in vec3 rayOri, in vec3 rayDir) {
  // 雾浓度系数
  float a = u_fogA;
  // 高度衰减系数
  float b = u_fogB;
  // 解析积分：从相机高度 rayOri.y 出发、沿 rayDir 走 distance 的雾量
  float fogAmount = (a / b) * exp(-rayOri.y * b) * (1.0 - exp(-distance * rayDir.y * b)) / rayDir.y;
  // 按雾量混向背景色
  return mix(rgb, u_bgColor, fogAmount);
}

// 用高度图 b 通道求屏幕空间导数（法线扰动 = bump mapping）
vec2 dHdxy_fwd() {
  // uv 在屏幕 x 方向的导数
  vec2 dSTdx = dFdx(v_uv);
  // uv 在屏幕 y 方向的导数
  vec2 dSTdy = dFdy(v_uv);
  // 高度缩放
  float scale = 0.1;
  // 当前像素高度
  float Hll = scale * texture2D(u_texture, v_uv).b;
  // x 方向高度差
  float dBx = scale * texture2D(u_texture, v_uv + dSTdx).b - Hll;
  // y 方向高度差
  float dBy = scale * texture2D(u_texture, v_uv + dSTdy).b - Hll;
  // 返回二维梯度
  return vec2(dBx, dBy);
}

// 用屏幕空间导数扰动法线（three 的 perturbNormalArb 同款实现）
vec3 perturbNormalArb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
  // 位置对屏幕 x 的导数
  vec3 vSigmaX = dFdx(surf_pos.xyz);
  // 位置对屏幕 y 的导数
  vec3 vSigmaY = dFdy(surf_pos.xyz);
  // 原始法线
  vec3 vN = surf_norm;
  // 切线基 R1
  vec3 R1 = cross(vSigmaY, vN);
  // 切线基 R2
  vec3 R2 = cross(vN, vSigmaX);
  // 行列式（乘 faceDirection 处理双面）
  float fDet = dot(vSigmaX, R1) * faceDirection;
  // 梯度向量
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  // 扰动后的法线
  return normalize(abs(fDet) * surf_norm - vGrad);
}

// 胶囊光源散射
#include <getScatter>
// 蓝噪声
#include <getBlueNoise>

void main() {
  // 蓝噪声（偏移 (48,31) 与其它材质错开）
  vec3 blueNoise = getBlueNoise(gl_FragCoord.xy + vec2(48.0, 31.0));
  // 采样地面贴图（r 阴影 / g 光照 / b 高度）
  vec3 mixedTexture = texture2D(u_texture, v_uv).rgb;
  // 烘焙阴影
  float shadow = mixedTexture.r;
  // 烘焙光照（下限 0.1，避免完全黑）
  float light = clamp(mixedTexture.g, 0.1, 1.0);
  // 双面渲染时翻转法线
  float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
  // 视图法线按朝向修正
  vec3 normal = normalize(v_viewNormal) * faceDirection;
  // 叠加高度图扰动
  normal = perturbNormalArb(-v_viewPosition, normal, dHdxy_fwd(), faceDirection);
  // 转世界空间法线
  vec3 N = inverseTransformDirection(normal, viewMatrix);
  // 世界空间光照方向
  vec3 L = normalize(u_lightPosition - v_worldPosition);
  // 世界空间视线方向
  vec3 V = normalize(cameraPosition - v_worldPosition);

  // 法线与视线夹角（保留原站计算，本移植未直接使用）
  float NdV = clamp(abs(dot(N, V)), 0.001, 1.0);
  // 地面 → 光源向量
  vec3 lightToWorld = v_worldPosition - u_lightPosition;
  // 到光源距离
  float distToLight = length(lightToWorld);
  // 点光衰减（噪波稳定因子越大，二次项系数略小 → 更亮）
  float attenutation = 1.0 / (0.05 + (0.025 - 0.005 * u_noiseStableFactor) * distToLight * distToLight);
  // 岩石软阴影：把本地坐标平铺到阴影图，并用蓝噪声做抖动防止摩尔纹
  float rockShadows = texture2D(u_groundShadowTexture, (vec2(v_localPosition.x, -v_localPosition.z) + (blueNoise.xy - 0.5) * 0.1) * 0.0425 + 0.5).r;
  // 高光：反射视线与光照方向点积；只在地面法线偏水平时出现（linearStep(0.9,0,N.y)）
  float spec = dot(reflect(V, N), L) * linearStep(0.9, 0.0, N.y) * 4.0;

  // 基础颜色 = 烘焙光照 + 点光高光
  vec3 col = vec3(light + attenutation * spec);
  // 乘烘焙阴影、岩石阴影（0.5~1.0 权重）与高光增强
  col *= shadow * (0.5 + rockShadows * 0.5) * (1.0 + spec);
  // 叠加指数高度雾
  col = applyFog(col, length(cameraPosition - v_worldPosition), cameraPosition, -V);
  // 叠加光柱散射
  col += getScatter(cameraPosition, v_worldPosition);

  // 原站编码：r=照明 g=深度 b=1 a=高光遮罩，交由 AboutPageHeroEfx 调色
  gl_FragColor = vec4(col, 0.0);
  // g 写线性深度（HUD 径向模糊 / 雾都靠它）
  gl_FragColor.g = v_depth;
  // b 先写 1（下一行会被覆盖成「远处标记」）
  gl_FragColor.b = 1.0;
  // HUD 阶段改用「阴影 × 法线水平度」作图：让地面在扫描线阶段呈现等高线质感
  gl_FragColor.r = mix(gl_FragColor.r, shadow * (1.0 - abs(N.y)), u_hudRatio);
  // 场景淡入 × HUD 出场比例压暗
  gl_FragColor.r *= u_sceneRatio * (1.0 - u_showRatio);
  // 深度加一点蓝噪声抖动，消除 8bit 深度带阶
  gl_FragColor.g -= blueNoise.z * 0.004;
  // b 表示「z 方向远处」：15→66 之间做线性过渡（雾片/HUD 线条都用同一编码）
  gl_FragColor.b = linearStep(15.0, 66.0, v_worldPosition.z);
  // a = 高光遮罩，决定泛光范围
  gl_FragColor.a = spec * shadow;
}
`;

/* 雾片阵列（原站 AboutHeroFog：32 片 3×3 细分面片 + 屏幕空间折射） */
/* 雾片顶点（逆向自 AboutHeroFog @1004394 的 vert$4）：
 * 32 片 3×3 细分面片，每片随机位置 a_instancePos 与随机数 a_instanceRands。
 *   localPos 先按随机角旋转 + 按 x 正负反向缓慢自转（u_introTime 驱动）
 *   pos = (9 + 2*rand)*localPos  —— 每片尺寸 9~11
 *   simplex 噪声推挤 —— 让雾团轮廓起伏而不是规则方形
 *   cycle = fract((0.08+0.08*rand)*t + rand) —— 每片沿 x 缓慢漂移并循环
 *   instancePos.y -= linearStep(4,1,|x|)*1 + 0.5 —— 靠近中心时下压，形成地平线雾带
 *   v_opacity 由深度 smoothstep(1,3,-z) × 场景比例 × 生命周期线性Step 决定；
 *   opacity < 0.004 时把顶点踢出裁剪空间（gl_Position.z = 2*w），省掉片元开销。
 * 末尾 #include <aboutHeroVisualFinal_vert> 负责写 v_depth（与地面同一编码）。 */
const FOG_VERT = /* glsl */ `varying vec3 v_worldPosition;varying vec2 v_uv;varying float v_depth;varying float v_instanceId;varying float v_opacity;attribute float a_instanceId;attribute vec3 a_instancePos;attribute vec3 a_instanceRands;uniform float u_introTime;uniform float u_sceneRatio;uniform float u_hudRatio;vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}float mod289(float x){return x-floor(x*(1.0/289.0))*289.0;}vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}float permute(float x){return mod289(((x*34.0)+1.0)*x);}vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}float taylorInvSqrt(float r){return 1.79284291400159-0.85373472095314*r;}vec4 grad4(float j,vec4 ip){const vec4 ones=vec4(1.0,1.0,1.0,-1.0);vec4 p,s;p.xyz=floor(fract(vec3(j)*ip.xyz)*7.0)*ip.z-1.0;p.w=1.5-dot(abs(p.xyz),ones.xyz);s=vec4(lessThan(p,vec4(0.0)));p.xyz=p.xyz+(s.xyz*2.0-1.0)*s.www;return p;}
#define F4 0.309016994374947451
vec4 simplexNoiseDerivatives(vec4 v_0){const vec4 C=vec4(0.138196601125011,0.276393202250021,0.414589803375032,-0.447213595499958);vec4 i=floor(v_0+dot(v_0,vec4(F4)));vec4 x0=v_0-i+dot(i,C.xxxx);vec4 i0;vec3 isX=step(x0.yzw,x0.xxx);vec3 isYZ=step(x0.zww,x0.yyz);i0.x=isX.x+isX.y+isX.z;i0.yzw=1.0-isX;i0.y+=isYZ.x+isYZ.y;i0.zw+=1.0-isYZ.xy;i0.z+=isYZ.z;i0.w+=1.0-isYZ.z;vec4 i3=clamp(i0,0.0,1.0);vec4 i2=clamp(i0-1.0,0.0,1.0);vec4 i1=clamp(i0-2.0,0.0,1.0);vec4 x1=x0-i1+C.xxxx;vec4 x2=x0-i2+C.yyyy;vec4 x3=x0-i3+C.zzzz;vec4 x4=x0+C.wwww;i=mod289(i);float j0=permute(permute(permute(permute(i.w)+i.z)+i.y)+i.x);vec4 j1=permute(permute(permute(permute(i.w+vec4(i1.w,i2.w,i3.w,1.0))+i.z+vec4(i1.z,i2.z,i3.z,1.0))+i.y+vec4(i1.y,i2.y,i3.y,1.0))+i.x+vec4(i1.x,i2.x,i3.x,1.0));vec4 ip=vec4(1.0/294.0,1.0/49.0,1.0/7.0,0.0);vec4 p0=grad4(j0,ip);vec4 p1=grad4(j1.x,ip);vec4 p2=grad4(j1.y,ip);vec4 p3=grad4(j1.z,ip);vec4 p4=grad4(j1.w,ip);vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;p4*=taylorInvSqrt(dot(p4,p4));vec3 values0=vec3(dot(p0,x0),dot(p1,x1),dot(p2,x2));vec2 values1=vec2(dot(p3,x3),dot(p4,x4));vec3 m0=max(0.5-vec3(dot(x0,x0),dot(x1,x1),dot(x2,x2)),0.0);vec2 m1=max(0.5-vec2(dot(x3,x3),dot(x4,x4)),0.0);vec3 temp0=-6.0*m0*m0*values0;vec2 temp1=-6.0*m1*m1*values1;vec3 mmm0=m0*m0*m0;vec2 mmm1=m1*m1*m1;float dx=temp0[0]*x0.x+temp0[1]*x1.x+temp0[2]*x2.x+temp1[0]*x3.x+temp1[1]*x4.x+mmm0[0]*p0.x+mmm0[1]*p1.x+mmm0[2]*p2.x+mmm1[0]*p3.x+mmm1[1]*p4.x;float dy=temp0[0]*x0.y+temp0[1]*x1.y+temp0[2]*x2.y+temp1[0]*x3.y+temp1[1]*x4.y+mmm0[0]*p0.y+mmm0[1]*p1.y+mmm0[2]*p2.y+mmm1[0]*p3.y+mmm1[1]*p4.y;float dz=temp0[0]*x0.z+temp0[1]*x1.z+temp0[2]*x2.z+temp1[0]*x3.z+temp1[1]*x4.z+mmm0[0]*p0.z+mmm0[1]*p1.z+mmm0[2]*p2.z+mmm1[0]*p3.z+mmm1[1]*p4.z;float dw=temp0[0]*x0.w+temp0[1]*x1.w+temp0[2]*x2.w+temp1[0]*x3.w+temp1[1]*x4.w+mmm0[0]*p0.w+mmm0[1]*p1.w+mmm0[2]*p2.w+mmm1[0]*p3.w+mmm1[1]*p4.w;return vec4(dx,dy,dz,dw)*49.0;}vec2 rotate(vec2 v,float a){float s=sin(a);float c=cos(a);mat2 m=mat2(c,s,-s,c);return m*v;}float linearStep(float edge0,float edge1,float x){return clamp((x-edge0)/(edge1-edge0),0.0,1.0);}void main(){vec3 localPos=position;localPos.xy=rotate(localPos.xy,a_instanceRands.y*6.28+sign(-a_instancePos.x)*u_introTime*mix(0.03,0.15,a_instanceRands.z));vec3 pos=(9.0+2.0*a_instanceRands.x)*localPos;vec3 noise=simplexNoiseDerivatives(vec4((a_instancePos+pos)*0.5,u_introTime*0.075)).yzw;float cycle=fract((0.08+0.08*a_instanceRands.x)*u_introTime+a_instanceRands.z);vec3 instancePos=a_instancePos+vec3(cycle*(a_instancePos.x*0.75+sign(a_instancePos.x)*0.25),0.0,0.0)+noise*vec3(0.35,0.2,0.1);instancePos.y-=linearStep(4.,1.,abs(instancePos.x))*1.+0.5;pos+=instancePos;vec4 mvPosition=modelViewMatrix*vec4(pos,1.);gl_Position=projectionMatrix*mvPosition;v_worldPosition=(modelMatrix*vec4(pos,1.)).xyz;v_uv=uv;v_instanceId=a_instanceId;float d=(modelViewMatrix*vec4(instancePos,1.0)).z;v_opacity=smoothstep(1.,3.,-d)*u_sceneRatio*(1.-u_hudRatio)*linearStep(0.,0.25,cycle)*linearStep(1.,0.75,cycle)*mix(1.,0.75,a_instanceRands.x);if(v_opacity<0.004){gl_Position.z=2.*gl_Position.w;}
#include <aboutHeroVisualFinal_vert>
}`;
/* 雾片片元（逆向自 AboutHeroFog 的 frag$4）：
 * 关键点是「屏幕空间折射」而不是常规混合：
 *   1) u_fogTexture.rg：r = 雾的密度/遮罩，g = 该片自身的深度偏移
 *   2) u_currSceneTexture：渲染雾之前把当前 RT 拷一份，用屏幕 uv 读取，
 *      于是雾片能取到它背后的场景深度（currScene.g）做比较
 *   3) 只有雾片比背后场景更近（depth - currScene.g）才可见，
 *      从而实现「雾挡在物体前面、又被更近物体挡住」的正确遮挡
 *   4) 输出 r = 密度 × 不透明度（加法叠亮度），gb 透传场景深度/远度，
 *      a = 指数衰减的雾色权重，混合方式是 SrcAlpha / OneMinusSrcAlpha（见 _buildFog）。
 * 注意 alpha 通道的混合被设成 Zero/One：即 alpha 不参与累积，避免雾互相叠加变白。 */
const FOG_FRAG = /* glsl */ `varying vec3 v_worldPosition;varying vec2 v_uv;varying float v_depth;varying float v_instanceId;varying float v_opacity;uniform sampler2D u_currSceneTexture;uniform sampler2D u_fogTexture;uniform vec2 u_resolution;uniform vec3 u_lightPosition;uniform float u_noiseStableFactor;uniform float u_time;
#define PI 3.141592653589793
#define PI2 6.283185307179586
#define PI_HALF 1.5707963267948966
#define RECIPROCAL_PI 0.3183098861837907
#define RECIPROCAL_PI2 0.15915494309189535
#define saturate( a ) clamp( a, 0.0, 1.0 )
#include <getBlueNoise>
#include <getScatter>
float linearStep(float edge0,float edge1,float x){return clamp((x-edge0)/(edge1-edge0),0.0,1.0);}void main(){float faceDirection=gl_FrontFacing ? 1.0 :-1.0;vec2 screenPaintUv=gl_FragCoord.xy/u_resolution;vec2 fogMap=texture2D(u_fogTexture,v_uv).rg;vec4 currScene=texture2D(u_currSceneTexture,screenPaintUv);float depth=v_depth-fogMap.y*0.02;float depthMask=fogMap.x*1.35-fogMap.y*0.15;gl_FragColor.r=depthMask*v_opacity;gl_FragColor.gb=currScene.gb;gl_FragColor.a=exp(-length(v_worldPosition+vec3(0.,0.,-max(0.,fogMap.y-0.25)*10.+5.)-vec3(0.,0.,0.))*(0.22-fogMap.x*0.2))*fogMap.y*linearStep(0.0,0.035,depth-currScene.g)*v_opacity*0.45;}`;

/* 远景散射盒（原站 AboutHeroHalo：bg_box.buf + frag$7） */
// 一个包住整个场景的盒子；顶点把 z 强制推到远平面（gl_Position.z = w），
// 于是它永远画在所有物体之后，只在「没有物体遮挡」的像素上出现光晕。
const HALO_VERT = /* glsl */ `
// 世界坐标（片元里做散射积分）
varying vec3 v_worldPosition;
// 光源位置（保留 uniform）
uniform vec3 u_lightPosition;
void main() {
  // 视图空间位置
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  // 标准投影
  gl_Position = projectionMatrix * mvPosition;
  // 世界坐标
  v_worldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  // 强制压到远平面：z = w 即「最远处」，保证被所有物体覆盖
  gl_Position.z = 1.0 * gl_Position.w;
}
`;

const HALO_FRAG = /* glsl */ `
// 世界坐标
varying vec3 v_worldPosition;
// 场景可见比例
uniform float u_sceneRatio;
// HUD 退场比例
uniform float u_hudRatio;
// 线条显影比例（此阶段光晕压掉）
uniform float u_showRatio;
// 胶囊光源散射
#include <getScatter>
// 蓝噪声
#include <getBlueNoise>
// 线性过渡
float linearStep(float edge0, float edge1, float x) { return clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0); }
void main() {
  // 蓝噪声（偏移 (57,27)，与其它材质错开）
  vec3 noise = getBlueNoise(gl_FragCoord.xy + vec2(57.0, 27.0));
  // r = 散射强度（远景光晕本体）
  gl_FragColor.r = getScatter(cameraPosition, v_worldPosition);
  // 乘场景比例与两个退场比例
  gl_FragColor.r *= u_sceneRatio * (1.0 - u_hudRatio) * (1.0 - u_showRatio);
  // g 固定 1（表示「背景」，雾片据此判断遮挡）
  gl_FragColor.g = 1.0;
  // b 是「远处标记」，与地面同一编码，供雾/HUD 线条使用
  gl_FragColor.b = linearStep(15.0, 66.0, v_worldPosition.z);
  // a = 0：不参与 alpha 混合，只做加法式亮度贡献
  gl_FragColor.a = 0.0;
  // 加极少量噪声，避免纯色区域出现色带
  gl_FragColor.r += noise.r * 0.004;
}
`;

/* ───────────────────────── 主类 ───────────────────────── */

// 原站用 shaderHelper.addChunk 注册 chunk；这里在编译前做文本替换
const CHUNKS = {
  // 胶囊光源散射
  getScatter: GET_SCATTER,
  // 蓝噪声采样
  getBlueNoise: GET_BLUE_NOISE,
  // 光源阴影图极坐标 uv
  getLightUv: GET_LIGHT_UV,
  // 光照场切片采样（来自 AboutHeroParticles）
  lightFieldSlice: LF_SLICE,
  // 通用深度编码片段：要求调用方已有 pos，并声明了 v_depth
  aboutHeroVisualFinal_vert: `float viewZ = (modelViewMatrix * vec4(pos, 1.0)).z;
float near = 1.0;
float far = 100.0;
v_depth = 1.0 - (viewZ + near) / (near - far);`,
};
// 把源码里独占一行的 #include <name> 替换成对应 chunk；未注册的保持原样
const withChunks = (src) =>
  // 只匹配「整行只有一个 include」，避免误伤字符串里的内容
  src.replace(/^[ \t]*#include[ \t]+<(\w+)>[ \t]*$/gm, (m, name) => CHUNKS[name] ?? m);

/* ── LUSION 标题：原站 AboutWhoLogo（logo_text.buf 逐顶点 morph） ──
 * 网格由 /logo 页面生成（x∈[0,1] 按字宽归一化，z=1 填充 / z=0 抗锯齿裙边，char=第几个字）。
 * 顶点着色器 vert$1 的两段动画：
 *   1) 入场：u_showRatio 按顶点 x（加 y*0.2）错峰，easeOutBack 从 DOM rect 下方升起；
 *   2) 退场：u_hideRatio 触发逐顶点 morph 到左侧小 logo 的 rect，并逐字错开。
 * 这里保持同一套数学，只把像素坐标直接映射到裁剪空间。 */
const LOGO_VERT = /* glsl */ `
// 第几个字（用于退场时逐字错开）
attribute float char;
// 入场比例（时间驱动，0→1）
uniform float u_showRatio;
// 退场/morph 比例（滚动驱动）
uniform float u_hideRatio;
// 主标题锚点 DOM 的宽高比（把归一化网格还原成不变形的字形）
uniform float u_aspect;
// 最大字索引（用于归一化逐字偏移）
uniform float u_charMax;
// 视口尺寸（像素）
uniform vec2 u_resolution;
// 主标题锚点的 DOM rect（左上角 + 宽高）
uniform vec2 u_domXY;
uniform vec2 u_domWH;
// DOM 中心（保留）
uniform vec2 u_domPivot;
// 退场目标（左侧小 logo）的 rect
uniform vec2 u_toDomXY;
uniform vec2 u_toDomWH;
// 到抗锯齿裙边的距离（0 = 填充内部，1 = 外缘）
varying float v_dist;
// 淡出系数
varying float v_fade;

// 线性过渡
float linearStep(float e0, float e1, float x) { return clamp((x - e0) / (e1 - e0), 0.0, 1.0); }
// 三次缓入缓出
float cubicInOut(float t) { return t < 0.5 ? 4.0 * t * t * t : 0.5 * pow(2.0 * t - 2.0, 3.0) + 1.0; }
// 一维三次贝塞尔求值（用于自定义缓动曲线）
float cubicBezier(float p0, float p1, float p2, float p3, float t) {
  // 控制点差分 1 阶
  float c = (p1 - p0) * 3.0;
  // 差分 2 阶
  float b = (p2 - p1) * 3.0 - c;
  // 差分 3 阶
  float a = p3 - p0 - c - b;
  // t²
  float t2 = t * t;
  // 三次多项式求值
  return a * t2 * t + b * t2 + c * t + p0;
}
// easeOutBack：末端冲过 1 再回弹（p1=1.3 制造过冲），入场更有弹性
float easeOutBack(float t) { return cubicBezier(0.0, 1.3, 1.1, 1.0, t); }

void main() {
  // 网格位置（z 未使用）
  vec3 pos = vec3(position.xy, 0.0);
  // 按锚点宽高比修正 y，避免字形被拉伸
  vec3 aspectCorrectedPos = pos * vec3(1.0, u_aspect, 1.0);
  // 把抗锯齿裙边距离直接透传（position.z = 1 填充 / 0 裙边）
  v_dist = position.z;

  // 主标题：局部 [0,1]² → DOM rect（DOM 的 y 向下）
  vec2 mainPx = u_domXY + vec2(aspectCorrectedPos.x, 1.0 - aspectCorrectedPos.y) * u_domWH;
  // 逐字错峰：x 越大越晚出现（再叠加 y*0.2 的斜向偏移），2.2 让整体在 showRatio 过半时完成
  float show = easeOutBack(linearStep(0.0, 1.0, u_showRatio * 2.2 - aspectCorrectedPos.x - aspectCorrectedPos.y * 0.2));
  // 未出现时整体下移一个 DOM 高度（+min(1.1h,100px) 的额外距离 = 从屏幕外升起）
  mainPx.y += (1.0 - show) * (u_domWH.y + min(u_domWH.y * 1.1, 100.0));

  // 退场目标：左侧小 logo，逐字 x 偏移
  float charShift = char / max(1.0, u_charMax) * 0.08;
  // 目标像素位置：同样按宽高比修正，并减去逐字偏移
  vec2 toPx = u_toDomXY + vec2(aspectCorrectedPos.x - charShift, 1.0 - aspectCorrectedPos.y) * u_toDomWH;

  // morph 进度：x 逐字错开，y 的幂次随 hideRatio 增长（(1+hide) 次幂 → 越到后面越集中）
  float hide = cubicInOut(linearStep(0.0, 1.0, u_hideRatio * 2.2 - aspectCorrectedPos.x - pow(aspectCorrectedPos.y, 1.0 + u_hideRatio) * 0.2));
  // 在主标题位置与目标位置之间插值
  vec2 px = mix(mainPx, toPx, hide);
  // 文案块已删除：morph 末端淡出，避免留下悬浮小 logo
  v_fade = 1.0 - smoothstep(0.82, 1.0, hide);

  // 像素坐标 → 裁剪空间（y 翻转，因为 DOM 的 y 向下）
  gl_Position = vec4(px.x / u_resolution.x * 2.0 - 1.0, 1.0 - px.y / u_resolution.y * 2.0, 0.0, 1.0);
}`;

// 标题片元：用「到裙边距离」的屏幕空间导数做抗锯齿（fwidth），不需要 MSAA；
// v_fade 负责 morph 末端淡出，alpha < 0.002 直接 discard 省掉混合开销。
const LOGO_FRAG = /* glsl */ `
// 到抗锯齿裙边的距离
varying float v_dist;
// 淡出系数
varying float v_fade;
void main() {
  // smoothstep 宽度取一个像素内的距离变化量 → 稳定的 1px 边缘
  float alpha = smoothstep(0.0, 0.0 + fwidth(v_dist), v_dist) * v_fade;
  // 几乎透明时直接丢弃，减少混合
  if (alpha < 0.002) discard;
  // 纯白标题
  gl_FragColor = vec4(1.0, 1.0, 1.0, alpha);
}`;

/**
 * AboutPageHeroEfxPrepass 的 Pass 版：把 readBuffer 转到 writeBuffer（灰度 / 运动模糊 / HUD 径向模糊），
 * 然后可选地把 HUD 人脸叠加同一张 RT 上（原站 render 里的 needsRenderScene 分支）。
 */
// 自定义 Pass：持有可热插拔的全屏材质，每帧可在三种预通道之间切换
class PreEfxPass extends Pass {
  constructor(material) {
    // 调用 three 的 Pass 基类构造
    super();
    // 当前使用的材质（会被 use() 替换）
    this.material = material;
    // 全屏四边形包装（three 的 FullScreenQuad 负责相机与几何）
    this.quad = new FullScreenQuad(material);
    // 需要与下一个 pass 交换缓冲（我们写 writeBuffer）
    this.needsSwap = true;
    // 不直接输出到屏幕
    this.renderToScreen = false;
    // 可选叠加场景（本例始终为 null，人脸层已被剔除）
    this.overlayScene = null;
    // 叠加场景使用的相机
    this.overlayCamera = null;
  }

  // 便捷访问当前材质的 uniform（外部可改 u_blurRatio 等）
  get uniforms() {
    // 直接转发材质 uniform 表
    return this.material.uniforms;
  }

  // 切换预通道材质（运动模糊 / HUD 径向模糊 / 纯灰度）
  use(material) {
    // 记录材质
    this.material = material;
    // 同步给全屏四边形
    this.quad.material = material;
  }

  // Pass 主入口：读 readBuffer，写 writeBuffer
  render(renderer, writeBuffer, readBuffer) {
    // 把上一步结果绑到材质的 u_texture
    this.material.uniforms.u_texture.value = readBuffer.texture;
    // 目标切到 writeBuffer
    renderer.setRenderTarget(writeBuffer);
    // 执行全屏绘制
    this.quad.render(renderer);
    // 若有可见的叠加场景，则关闭自动清屏再叠加渲染（原站做法）
    if (this.overlayScene && this.overlayScene.visible) {
      // 防止清掉刚写入的内容
      renderer.autoClear = false;
      // 叠加渲染
      renderer.render(this.overlayScene, this.overlayCamera);
    }
  }

  // 释放 Pass 资源
  dispose() {
    // 全屏四边形
    this.quad.dispose();
    // 当前材质
    this.material.dispose();
  }
}

// 整场体验的编排器：资源 / 场景对象 / 后期链 / 每帧滚动编排都在这里
export class AboutExperience {
  constructor() {
    // 最近一次读取的滚动位置（scroll 事件里更新，渲染帧里使用）
    this._scrollY = 0;
    // 体验自身的时间轴（秒），不受子弹时间影响
    this._time = 0;
    // 入场时间轴（会被子弹时间减速），驱动物理/材质动画
    this.introTime = 0;
    // 场景态调色：burn 冷青
    this._sceneBurn = new THREE.Color('#00f0ff');
    // 场景态调色：dodge 蓝
    this._sceneDodge = new THREE.Color('#005aff');
    // HUD 态调色：burn 浅蓝（当前未启用，hudE 恒为 0）
    this._hudBurn = new THREE.Color('#79a8ff');
    // HUD 态调色：dodge 黄绿（当前未启用）
    this._hudDodge = new THREE.Color('#a5ff44');
    // RAF 句柄
    this._raf = 0;
    // 资源是否就绪
    this._ready = false;
    // 是否已销毁（用于中止 RAF 循环）
    this._disposed = false;
    // 相机样条点数的缓存（当前未使用）
    this._splineCount = 0;
    // 交互：按住 = 子弹时间；移动鼠标 = 镜头 look 偏移（原站 freezeRatio / cameraLookStrength）
    // 子弹时间混合比例 0..1（按住时缓动到 1-hudRatio）
    this.freezeRatio = 0;
    // 标题退场比例（时间驱动，滚动回顶部会回 0）
    this._logoHide = 0;
    // 指针是否按下
    this._pointerDown = false;
    // 鼠标 NDC 坐标（-1..1）
    this._mouse = { x: 0, y: 0 };
    // 当前 look 偏移的缓动值（俯仰）
    this._lookX = 0;
    // 当前 look 偏移的缓动值（偏航）
    this._lookY = 0;
    // 复用的欧拉角
    this._lookEuler = new THREE.Euler();
    // 复用的四元数（叠加到相机朝向上）
    this._lookQuat = new THREE.Quaternion();
    // 鼠标移动：把像素坐标转成 NDC
    this._onPointerMove = (e) => {
      // x：0..1 → -1..1
      this._mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      // y：屏幕坐标向下，取反后才符合 NDC 向上
      this._mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };
    // 按下指针 → 进入子弹时间
    this._onPointerDown = () => {
      // 置位
      this._pointerDown = true;
    };
    // 松开/取消指针 → 退出子弹时间
    this._onPointerUp = () => {
      // 复位
      this._pointerDown = false;
    };
  }

  // 挂载：建渲染器 / 场景 / 共享 uniform → 加载资源 → 逐层构建 → 组装后期链 → 启动 RAF
  async mount(host, els = {}) {
    // 记录 canvas 容器
    this.host = host;
    // 记录外部传入的 DOM 引用（introEl / logoEl）
    this.els = els;

    // WebGL 渲染器：开抗锯齿、不透明背景、优先独显
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    // 像素比上限 2，避免 3x 屏下开销翻倍
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // 初始尺寸跟随容器（容器尚未布局时退回视口）
    renderer.setSize(host.clientWidth || window.innerWidth, host.clientHeight || window.innerHeight);
    // 输出 sRGB（否则整体会偏暗）
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // 关闭自动清屏：每帧由 _renderFrame 手动清（雾/阴影 pass 依赖这点）
    renderer.autoClear = false;
    // canvas 插入容器
    host.appendChild(renderer.domElement);
    // 保存引用
    this.renderer = renderer;

    // 主场景
    this.scene = new THREE.Scene();
    // 主相机：60° 起始 FOV，near 1 / far 200（深度编码按 1..100 归一化）
    this.camera = new THREE.PerspectiveCamera(60, 1, 1, 200);

    // 共享 uniform（原站 light / scatter / blueNoise / aboutHero 的 sharedUniforms）
    // 点光源位置（粒子/地面/岩石共用）
    this.lightPosition = new THREE.Vector3(0, 8, 0);
    // 胶囊散射光源的上端点
    this.scatterPos0 = new THREE.Vector3(0, 18, 0);
    // 胶囊散射光源的下端点
    this.scatterPos1 = new THREE.Vector3(0, 0, 0);
    // 布朗运动辅助向量（保留）
    this._brown0 = new THREE.Vector3();
    // 布朗运动辅助向量（保留）
    this._brown1 = new THREE.Vector3();

    // 全局共享 uniform 表：所有材质通过 ...this.shared 合并，改一处全场景生效
    this.shared = {
      // 点光源位置（引用同一个 Vector3 对象）
      u_lightPosition: { value: this.lightPosition },
      // 光照颜色（本移植未参与计算）
      u_lightColor: { value: new THREE.Color('#000') },
      // 散射分母（近/远）
      u_lightScatterDivider: { value: new THREE.Vector2(1.1, 5.5) },
      // 散射输出幂次倒数
      u_lightScatterPowInv: { value: 1 },
      // 散射总强度
      u_lightScatterRatio: { value: 1 },
      // 胶囊光源上端点
      u_lightScatterPos0: { value: this.scatterPos0 },
      // 胶囊光源下端点
      u_lightScatterPos1: { value: this.scatterPos1 },
      // 场景可见比例（入场淡入）
      u_sceneRatio: { value: 0 },
      // HUD 全局比例
      u_hudRatio: { value: 0 },
      // 入场时间（减速版）
      u_introTime: { value: 0 },
      // 入场 dt（减速版）
      u_introDeltaTime: { value: 0 },
      // 全局时间（不减速）
      u_time: { value: 0 },
      // HUD 线条显影比例
      u_showRatio: { value: 0 },
      // 字体图集（HUD 字母层）
      u_letterTexture: { value: null },
      // 背景/雾色
      u_bgColor: { value: new THREE.Color('#000') },
      // 场景隐藏比例（HUD 之前整体收缩）
      u_sceneHideRatio: { value: 0 },
      // 噪波稳定因子（由粒子 sim 每帧写入）
      u_noiseStableFactor: { value: 0 },
      // 蓝噪声图
      u_blueNoiseTexture: { value: null },
      // 蓝噪声纹素尺寸（128×128）
      u_blueNoiseTexelSize: { value: new THREE.Vector2(1 / 128, 1 / 128) },
      // 蓝噪声采样相位偏移
      u_blueNoiseCoordOffset: { value: new THREE.Vector2() },
      // 画布分辨率（像素）
      u_resolution: { value: new THREE.Vector2(1, 1) },
    };

    // 加载所有 buf / 贴图（相机构建前先备好地形、噪声、字体等）
    await this._loadAssets();

    // 光源 + 1024×2048 阴影图
    this._buildLight();
    // 地形
    this._buildGround();
    // 远景光晕盒
    this._buildHalo();
    // 雾片阵列
    this._buildFog();
    // 地面软阴影双缓冲（依赖 groundMesh，必须在 _buildGround 之后）
    this._buildGroundShadow();
    // 漂浮岩石（含阴影 pass 网格）
    await this._buildRocks();
    // 宇航员（骨骼蒙皮）
    await this._buildPerson();
    // 粒子星云 + 光照场（依赖 shared 与 renderer）
    await this._buildParticles();
    // LUSION 标题
    await this._buildLogo();
    // HUD 线条与字母
    await this._buildHud();

    // 后期：原站队列 efxPrepass(5) → bloom(10) → efx(20)
    // 合成器：内部维护两张半浮点 RT，pass 之间自动 ping-pong
    const composer = new EffectComposer(renderer);
    // 先按窗口尺寸定一次（随后 resize 会再对齐）
    composer.setSize(window.innerWidth, window.innerHeight);
    // 第 1 个 pass：把主场景渲进 composer 的 readBuffer
    composer.addPass(new RenderPass(this.scene, this.camera));
    // 预通道 A：纯灰度（r → 灰度，a 作泛光遮罩）
    this.preBaseMat = new THREE.ShaderMaterial({
      // 由 Pass 每次渲染前写入 readBuffer
      uniforms: { u_texture: { value: null } },
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // 灰度预通道
      fragmentShader: PRE_EFX_FRAG,
      // 后处理不需要深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });
    // 预通道 B：屏幕空间运动模糊
    this.preMotionMat = new THREE.ShaderMaterial({
      // 场景 / 速度图 / 模糊比例
      uniforms: {
        // 场景颜色（Pass 写入）
        u_texture: { value: null },
        // 1/4 分辨率速度图
        u_motionTexture: { value: null },
        // 模糊比例（入场 1→1.5，之后 0）
        u_blurRatio: { value: 0 },
      },
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // 运动模糊片元（含 #include，需要 chunk）
      fragmentShader: withChunks(MOTION_BLUR_FRAG),
      // 无深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });
    // 预通道 C：HUD 阶段径向模糊
    this.preHudBlurMat = new THREE.ShaderMaterial({
      // 场景 + 宽高比 + 模糊比例（外加 shared 以便 getBlueNoise 拿到噪声图）
      uniforms: {
        // 展开全局共享（蓝噪声纹理等）
        ...this.shared,
        // 场景颜色（Pass 写入）
        u_texture: { value: null },
        // 屏幕宽高比
        u_aspect: { value: 1 },
        // 模糊比例（= hudRatio）
        u_blurRatio: { value: 0 },
      },
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // 径向模糊片元
      fragmentShader: withChunks(HUD_BLUR_FRAG),
      // 无深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });
    // 预通道 Pass：默认用灰度材质
    this.preEfxPass = new PreEfxPass(this.preBaseMat);
    // 叠加场景相机（当前未使用）
    this.preEfxPass.overlayCamera = this.camera;
    // 插到 RenderPass 之后（对应原站 efxPrepass 的 order 5）
    composer.addPass(this.preEfxPass);

    // 运动模糊：1/4 分辨率 motion RT + 可分离 9-tap（原站 blur.blur(2, 1, …)）
    // 速度图 RT：低分辨率 + 线性过滤，够用且省带宽
    this.motionRT = new THREE.WebGLRenderTarget(1, 1, {
      // 线性放大
      minFilter: THREE.LinearFilter,
      // 线性缩小
      magFilter: THREE.LinearFilter,
      // 速度网格有深度排序，需要深度缓冲
      depthBuffer: true,
      // 无模板
      stencilBuffer: false,
    });
    // 可分离模糊的中转 RT
    this.motionTmpRT = new THREE.WebGLRenderTarget(1, 1, {
      // 线性放大
      minFilter: THREE.LinearFilter,
      // 线性缩小
      magFilter: THREE.LinearFilter,
      // 不需要深度
      depthBuffer: false,
      // 无模板
      stencilBuffer: false,
    });
    // 9-tap 模糊材质（水平 / 垂直各用一次）
    this.blurMat = new THREE.ShaderMaterial({
      // 输入 + 单步偏移
      uniforms: { u_texture: { value: null }, u_delta: { value: new THREE.Vector2() } },
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // 9-tap 高斯
      fragmentShader: BLUR9_FRAG,
      // 无深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });
    // 预通道直接采样模糊后的速度图
    this.preMotionMat.uniforms.u_motionTexture.value = this.motionRT.texture;

    // 通用全屏 quad（速度清屏 / 模糊 / 拷贝都用它）
    this._fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    // 不剔除
    this._fsQuad.frustumCulled = false;
    // 专用场景
    this._fsScene = new THREE.Scene();
    // 入场景
    this._fsScene.add(this._fsQuad);
    // motion RT 的中性色必须是 0.5（不能用 setClearColor，会被色彩管理转成线性 0.216）
    // 所以用一张「输出 0.5」的全屏材质来「清屏」，速度 0 代表不模糊。
    this._motionClearMat = new THREE.ShaderMaterial({
      // 无需 uniform
      uniforms: {},
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // 直接输出 0.5 中性灰，alpha 0
      fragmentShader: 'varying vec2 v_uv; void main() { gl_FragColor = vec4(0.5, 0.5, 0.5, 0.0); }',
      // 无深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });
    // 泛光 Pass（自定义实现，保留原站的 halo / saturation 等参数）
    this.bloom = new GoalBloomPass();
    // 尺寸与 composer 对齐
    this.bloom.setSize(composer.renderTarget1.width, composer.renderTarget1.height);
    // 泛光强度基准（每帧按滚动再调）
    this.bloom.amount = 3;
    // 不直接输出屏幕（后面还有 efx）
    this.bloom.renderToScreen = false;
    // 加入链（对应原站 order 10）
    composer.addPass(this.bloom);
    // 原站场景态：burn #00f0ff @.15 / dodge #005aff @.12
    this.efxPass = new ShaderPass({
      // 调色参数
      uniforms: {
        // 输入（Pass 自动写入）
        u_texture: { value: null },
        // burn 色（冷青）
        u_colorBurn: { value: new THREE.Color('#00f0ff') },
        // burn 强度
        u_colorBurnAlpha: { value: 0.15 },
        // dodge 色（蓝）
        u_colorDodge: { value: new THREE.Color('#005aff') },
        // dodge 强度
        u_colorDodgeAlpha: { value: 0.12 },
      },
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // 双色调调色
      fragmentShader: EFX_FRAG,
    });
    // 指定 ShaderPass 的输入 uniform 名
    this.efxPass.textureID = 'u_texture';
    // 最后一个 pass，直接输出到屏幕
    this.efxPass.renderToScreen = true;
    // 关闭混合：调色结果直接覆盖
    this.efxPass.material.blending = THREE.NoBlending;
    // 无深度
    this.efxPass.material.depthTest = false;
    // 不写深度
    this.efxPass.material.depthWrite = false;
    // 加入链（对应原站 order 20）
    composer.addPass(this.efxPass);

    // —— 原站全局 PostEffect 队列末段：Final(30) → Smaa(500) → Fsr(2000) ——
    // Final：暗角 / dither / 调色；原站默认关闭
    this.finalPass = new FinalPass();
    // 与原站 settings 一致：默认不启用
    this.finalPass.enabled = false;
    // 温和的暗角范围（开启时可见但不压暗画面）
    this.finalPass.vignetteFrom = 1.1;
    this.finalPass.vignetteTo = 2.1;
    // 加入链
    composer.addPass(this.finalPass);

    // Smaa：常驻抗锯齿（原站一直开启）
    this.smaaPass = new SmaaPass();
    // 默认开启
    this.smaaPass.enabled = true;
    // 加入链
    composer.addPass(this.smaaPass);

    // Fsr：原站仅 UP_SCALE>1 时启用；这里保留能力但默认关闭
    this.fsrPass = new FsrPass();
    // 默认关闭
    this.fsrPass.enabled = false;
    // 加入链
    composer.addPass(this.fsrPass);
    // 保存合成器
    this.composer = composer;

    // 滚动监听：只记录 scrollY，真正的编排在 _renderFrame 里统一算
    this._onScroll = () => { this._scrollY = window.scrollY || 0; };
    // passive 提升滚动性能（不会 preventDefault）
    window.addEventListener('scroll', this._onScroll, { passive: true });
    // 立即同步一次初始滚动位置（刷新时可能已在页面中部）
    this._onScroll();

    // resize 监听
    this._onResize = () => this.resize();
    // 绑定
    window.addEventListener('resize', this._onResize);
    // 立即执行一次，建立正确的初始尺寸
    this.resize();

    // 标记就绪
    this._ready = true;
    // 挂到 window 便于调试（原站行为）
    window.__about = this; // debug
    // 记录上一帧时间戳（dt 计算基准）
    this._lastT = performance.now();
    // 指针移动 → look 偏移 / 人脸光源
    window.addEventListener('pointermove', this._onPointerMove);
    // 按下 → 子弹时间
    window.addEventListener('pointerdown', this._onPointerDown);
    // 抬起 → 退出子弹时间
    window.addEventListener('pointerup', this._onPointerUp);
    // 取消（手势/来电等）同样退出
    window.addEventListener('pointercancel', this._onPointerUp);
    // RAF 主循环
    this._tick = () => {
      // 已销毁则不再续帧
      if (this._disposed) return;
      // 先排下一帧（保证异常时循环不中断）
      this._raf = requestAnimationFrame(this._tick);
      // 渲染一帧
      this._renderFrame();
    };
    // 启动循环
    this._raf = requestAnimationFrame(this._tick);
  }

  // 资源装载：相机样条 / 地形 / 背景盒 / 蓝噪声 / 地面贴图 / 雾 / 字体
  async _loadAssets() {
    // 资源根路径
    const BASE = '/assets/';
    // 并行加载 4 份基础数据
    const [spline, terrain, bgBox, noiseTex] = await Promise.all([
      // 相机样条：位置 + 朝向（149 段）
      loadBuf(BASE + 'models/about/camera_spline.buf'),
      // 月面地形网格（含 uv）
      loadBuf(BASE + 'models/about/terrain.buf'),
      // 远景散射盒
      loadBuf(BASE + 'models/about/bg_box.buf'),
      // 128×128 RGB 蓝噪声
      new THREE.TextureLoader().loadAsync(BASE + 'textures/LDR_RGB1_0.png'),
    ]);
    // 保存样条
    this.spline = spline;
    // 保存地形几何（后面 _buildGround 直接用）
    this.terrainGeo = terrain;
    // 保存背景盒几何
    this.bgBoxGeo = bgBox;
    // 蓝噪声必须最近邻：插值会破坏噪声的随机性
    noiseTex.minFilter = THREE.NearestFilter;
    // 同上
    noiseTex.magFilter = THREE.NearestFilter;
    // 平铺寻址：gl_FragCoord 转 uv 后会自动循环
    noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
    // 写进 shared，供所有 getBlueNoise 使用
    this.shared.u_blueNoiseTexture.value = noiseTex;

    // 地面贴图：r=烘焙阴影 g=烘焙光照 b=高度
    const groundTex = await new THREE.TextureLoader().loadAsync(BASE + 'textures/about/terrain_shadow_light_height.webp');
    // three 默认 flipY，这里显式保持 true，让 uv 与地形网格约定一致
    groundTex.flipY = true;
    // 线性放大
    groundTex.minFilter = THREE.LinearFilter;
    // 线性缩小
    groundTex.magFilter = THREE.LinearFilter;
    // 保存
    this.groundTex = groundTex;

    // 雾片贴图（r=密度 g=深度偏移）
    const fogTex = await new THREE.TextureLoader().loadAsync(BASE + 'textures/about/fog.png');
    // 边缘钳制：雾片 uv 不重复
    fogTex.wrapS = fogTex.wrapT = THREE.ClampToEdgeWrapping;
    // 保存
    this.fogTex = fogTex;

    // HUD 字母使用的字体图集
    const fontTex = await new THREE.TextureLoader().loadAsync(BASE + 'textures/font.png');
    // 线性放大（字条会被放大很多）
    fontTex.minFilter = THREE.LinearFilter;
    // 线性缩小
    fontTex.magFilter = THREE.LinearFilter;
    // 写进 shared（HUD 的 letterMat 直接从 shared 取）
    this.shared.u_letterTexture.value = fontTex;

    // 岩石阴影累积贴图占位：全白 = 无遮挡
    // 1×1 白色 DataTexture，真正的 768×768 双缓冲在 _buildGroundShadow 里创建
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    // 上传
    white.needsUpdate = true;
    // 保存（_buildGround 先用它，避免首帧读空纹理）
    this.groundShadowTex = white;
  }

  /* ── 光源阴影图：1024x2048，RGB 存到光源的距离（原站 AboutHeroLight） ── */
  _buildLight() {
    // 阴影 RT：上半张 + 下半张拼成全向投影，HalfFloat 保证距离精度
    const rt = new THREE.WebGLRenderTarget(1024, 2048, {
      // 半精度浮点：距离范围 0..1，够用且省带宽
      type: THREE.HalfFloatType,
      // 需要深度：靠深度测试保留最近遮挡
      depthBuffer: true,
      // 线性放大
      minFilter: THREE.LinearFilter,
      // 线性缩小
      magFilter: THREE.LinearFilter,
    });
    // 保存
    this.lightShadowRT = rt;
    // 注入 shared（岩石阴影 pass 与地面 pass 都要用）
    this.shared.u_lightShadowTexture = { value: rt.texture };
    // 距离归一化上限：超过 12 一律视为最远
    this.shared.u_lightShadowMaxDistance = { value: 12 };
    // 纹素尺寸（getLightUv 钳边用）
    this.shared.u_lightShadowTextureTexelSize = { value: new THREE.Vector2(1 / 1024, 1 / 2048) };
    // 相机只用于把顶点投到 uv，实际位置由 shader 直接写 gl_Position
    // 用一个空相机占位，render(mesh, camera) 需要非空参数
    this.shadowCamera = new THREE.Camera();
  }

  /* ── 地面软阴影累积：768x768 双缓冲 ping-pong ── */
  _buildGroundShadow() {
    // RT 参数：半精度 + 无深度（纯 2D 阴影图）
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    // 两张 768×768：一张读（上一帧）、一张写（本帧）
    this.gShadowRT = [new THREE.WebGLRenderTarget(768, 768, opts), new THREE.WebGLRenderTarget(768, 768, opts)];
    // 当前读缓冲索引
    this.gShadowIdx = 0;
    // ground shadow pass 的 uniform
    const u = {
      // 全局共享（光源位置 / 噪声等）
      ...this.shared,
      // 上一帧结果（每帧写入）
      u_prevTexture: { value: null },
      // 光源方向的距离图
      u_lightShadowTexture: { value: this.lightShadowRT.texture },
      // 阴影覆盖半径（世界单位）
      u_radius: { value: 12 },
      // 一个像素对应的 uv 尺寸
      u_texelSize: { value: 1 / 768 },
      // 蓝噪声偏移（每帧随机，用于 8-tap 抖动）
      u_blueNoiseOffset: { value: new THREE.Vector2() },
    };
    // 保存，便于 _updateGroundShadow 改 offset
    this.gShadowUniforms = u;
    // 累积材质
    const mat = new THREE.ShaderMaterial({
      // 上面的 uniform
      uniforms: u,
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // 8-tap 软阴影片元
      fragmentShader: withChunks(GROUND_SHADOW_FRAG),
      // 注入采样次数常量（shader 里用 LIGHT_SHADOW_SAMPLE_COUNT）
      defines: { LIGHT_SHADOW_SAMPLE_COUNT: 8 },
      // 无深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });
    // 全屏 quad
    this.gShadowQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    // 不剔除
    this.gShadowQuad.frustumCulled = false;
    // 专用场景
    this.gShadowScene = new THREE.Scene();
    // 入场景
    this.gShadowScene.add(this.gShadowQuad);
    // 初始全白
    [0, 1].forEach((i) => {
      // 保存当前渲染目标
      const prev = this.renderer.getRenderTarget();
      // 切到该缓冲
      this.renderer.setRenderTarget(this.gShadowRT[i]);
      // 白色 = 完全受光
      this.renderer.setClearColor(0xffffff, 1);
      // 只清颜色
      this.renderer.clear(true, false, false);
      // 还原
      this.renderer.setRenderTarget(prev);
    });
    // 地形材质改用累积结果
    // （_buildGround 先用 1×1 白色占位，这里替换成真正的 768×768 缓冲）
    this.groundMesh.material.uniforms.u_groundShadowTexture.value = this.gShadowRT[0].texture;
  }

  /* ── 漂浮岩石：4 个模型 × 64 实例 + 120 帧烘焙动画 ── */
  async _buildRocks() {
    // 资源根路径
    const BASE = '/assets/';
    // 每种岩石模型的实例数
    const COUNT = 64;
    // 每块岩石被切成的碎块数（对应动画贴图的列数）
    const PIECE = 16;
    // 烘焙动画帧数（对应动画贴图的行数）
    const FRAMES = 120;

    // rocks.webp 四象限 → 512x512 RGBA 打包图
    // 原图是 2×2 拼的四张灰度纹理，先跑一次 PACK_FRAG 拆成 RGBA，材质里按通道挑选
    const rockTex = await new THREE.TextureLoader().loadAsync(BASE + 'textures/about/rocks.webp');
    // 打包目标 RT（8 位足够，灰度纹理）
    const packRT = new THREE.WebGLRenderTarget(512, 512, { type: THREE.UnsignedByteType });
    // 打包材质
    const packMat = new THREE.ShaderMaterial({
      // 输入原图
      uniforms: { u_texture: { value: rockTex } },
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // 四象限 → RGBA
      fragmentShader: PACK_FRAG,
      // 无深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });
    // 全屏 quad
    const packQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), packMat);
    // 不剔除
    packQuad.frustumCulled = false;
    // 专用场景
    const packScene = new THREE.Scene();
    // 入场景
    packScene.add(packQuad);
    // 保存当前渲染目标
    const prev = this.renderer.getRenderTarget();
    // 切到打包 RT
    this.renderer.setRenderTarget(packRT);
    // 执行一次打包（相机无实际作用）
    this.renderer.render(packScene, this.shadowCamera);
    // 还原
    this.renderer.setRenderTarget(prev);
    // 打包用的 quad 与材质都可以立即释放（结果已在 RT 里）
    packQuad.geometry.dispose();
    // 释放材质
    packMat.dispose();
    // 保存打包后的纹理
    this.packedRockTex = packRT.texture;

    // 岩石网格（4 种模型）
    this.rockMeshes = [];
    // 岩石的阴影 pass 网格（低模）
    this.rockShadowMeshes = [];
    // 每种模型独立的 uniform（时间/缩放/通道选择器不同）
    this.rockUniforms = [];

    // 逐种模型构建
    for (let type = 0; type < 4; type++) {
      // 并行加载高模 / 低模 / 烘焙动画
      const [hi, lo, anim] = await Promise.all([
        // 高模：屏幕上看到的岩石
        loadBuf(BASE + `models/about/rock_${type}.buf`),
        // 低模：只用于阴影投影
        loadBuf(BASE + `models/about/rock_${type}_low.buf`),
        // 动画：16 块碎片 × 120 帧的位置与朝向
        loadBuf(BASE + `models/about/rock_animation_${type}.buf`),
      ]);

      // 动画贴图：16x120，位置 RGB + piece 随机 A
      // 位置数组（每帧每块 3 个 float）
      const pos = anim.attributes.position.array;
      // 朝向数组（四元数，每帧每块 4 个 float）
      const orient = anim.attributes.orient.array;
      // 总帧数 × 块数 = 顶点数
      const frames = pos.length / 3;
      // 位置纹理数据：RGBA（xyz + piece 随机）
      const posData = new Float32Array(frames * 4);
      // 每块碎片的固定随机数（同一块在所有帧里保持一致）
      const pieceRand = [];
      // 逐顶点搬运
      for (let i = 0, o = 0; i < frames; i++, o += 4) {
        // 该顶点属于第几块碎片（列号）
        const piece = i % PIECE;
        // 每块只在第一帧生成一次随机数，后续帧复用
        if (i < PIECE) pieceRand[i] = Math.random();
        // x
        posData[o] = pos[i * 3];
        // y
        posData[o + 1] = pos[i * 3 + 1];
        // z
        posData[o + 2] = pos[i * 3 + 2];
        // a：该块的固定随机数
        posData[o + 3] = pieceRand[piece];
      }
      // 位置动画纹理（16 列 × 120 行）
      const posTex = new THREE.DataTexture(posData, PIECE, FRAMES, THREE.RGBAFormat, THREE.FloatType);
      // 上传
      posTex.needsUpdate = true;
      // 最近邻：帧号是整数索引，插值会串帧
      posTex.minFilter = posTex.magFilter = THREE.NearestFilter;
      // 朝向动画纹理（四元数）
      const orientTex = new THREE.DataTexture(orient, PIECE, FRAMES, THREE.RGBAFormat, THREE.FloatType);
      // 上传
      orientTex.needsUpdate = true;
      // 最近邻
      orientTex.minFilter = orientTex.magFilter = THREE.NearestFilter;

      // 实例属性
      // 实例编号
      const instId = new Float32Array(COUNT);
      // 逐实例随机数（4 个分量）
      const instRands = new Float32Array(COUNT * 4);
      // 逐实例生成
      for (let n = 0; n < COUNT; n++) {
        // 全局唯一编号：类型 + 序号×4（保证 hash 不碰撞）
        instId[n] = type + n * 4;
        // 时间相位
        instRands[n * 4] = Math.random();
        // 出现阈值
        instRands[n * 4 + 1] = Math.random();
        // 半径/旋转
        instRands[n * 4 + 2] = Math.random();
        // 整体尺度
        instRands[n * 4 + 3] = Math.random();
      }

      // 该模型的 uniform 表
      const uniforms = {
        // 全局 shared（时间 / HUD / 噪声 / 光源）
        ...this.shared,
        // 打包后的岩石贴图
        u_texture: { value: this.packedRockTex },
        // 通道选择器：当前模型对应的通道为 1，其余 0（one-hot）
        u_textureChannelMixer: { value: new THREE.Vector4(type === 0 ? 1 : 0, type === 1 ? 1 : 0, type === 2 ? 1 : 0, type === 3 ? 1 : 0) },
        // 位置动画贴图
        u_posRandTexture: { value: posTex },
        // 朝向动画贴图
        u_orientTexture: { value: orientTex },
        // 动画贴图尺寸（16, 120）
        u_animationTextureSize: { value: new THREE.Vector2(PIECE, FRAMES) },
        // 循环时间（受子弹时间影响）
        u_time: { value: 0 },
        // 全局时间（不受影响，驱动漂浮）
        u_globalTime: { value: 0 },
        // 整体缩放（入场）
        u_scale: { value: 0 },
      };
      // 保存，_renderFrame 每帧更新
      this.rockUniforms.push(uniforms);

      // 用给定网格构造实例化几何（高模 / 低模共用同一套实例属性）
      const makeGeo = (geo, withUv) => {
        // 实例化几何
        const ig = new THREE.InstancedBufferGeometry();
        // 源网格的顶点属性
        for (const [k, v] of Object.entries(geo.attributes)) ig.setAttribute(k, v);
        // 索引
        ig.setIndex(geo.index);
        // 实例编号（逐实例）
        ig.setAttribute('instanceId', new THREE.InstancedBufferAttribute(instId, 1));
        // 实例随机数（逐实例）
        ig.setAttribute('instanceRands', new THREE.InstancedBufferAttribute(instRands, 4));
        // 实例数量
        ig.instanceCount = COUNT;
        // 返回
        return ig;
      };

      // 高模网格
      const mesh = new THREE.Mesh(
        // 实例化高模
        makeGeo(hi),
        // 岩石材质（顶点做动画，片元做光照/散射）
        new THREE.ShaderMaterial({ uniforms, vertexShader: withChunks(ROCK_VERT), fragmentShader: withChunks(ROCK_FRAG) })
      );
      // shader 里改了位置，包围盒不可信
      mesh.frustumCulled = false;
      // 渲染顺序 5：与粒子同层，早于雾与 HUD
      mesh.renderOrder = 5;
      // 加入主场景
      this.scene.add(mesh);
      // 记录
      this.rockMeshes.push(mesh);

      // 阴影材质：同一个顶点着色器，但走 IS_SHADOW 分支
      const shadowMat = new THREE.ShaderMaterial({
        // 复用同一份 uniform（时间/缩放与本体严格同步）
        uniforms,
        // 顶点（IS_SHADOW 分支写 gl_Position 与 v_distToLight）
        vertexShader: withChunks(ROCK_VERT),
        // 片元只输出距离
        fragmentShader: LIGHT_SHADOW_FRAG,
        // 打开阴影分支
        defines: { IS_SHADOW: 1 },
        // 双面：碎片很薄，背面也要投影
        side: THREE.DoubleSide,
      });
      // 阴影网格用低模（省顶点）
      const shadowMesh = new THREE.Mesh(makeGeo(lo), shadowMat);
      // 手动投影，不剔除
      shadowMesh.frustumCulled = false;
      // 记录（每帧由 _renderLightShadow 渲染）
      this.rockShadowMeshes.push(shadowMesh);
    }
    // 记录实例总数（当前未使用）
    this._rockCount = COUNT;
  }

  // 地面：单一网格 + 自定义着色器（烘焙阴影/光照/高度 + 点光 + 岩石软阴影 + 雾 + 散射）
  _buildGround() {    const u = {
      // 全局共享 uniform
      ...this.shared,
      // 地面三通道贴图
      u_texture: { value: this.groundTex },
      // 岩石软阴影（先给 1×1 全白占位，_buildGroundShadow 后替换）
      u_groundShadowTexture: { value: this.groundShadowTex },
      // 地面基色（未参与实际计算）
      u_color: { value: new THREE.Color('#fff') },
      // 雾浓度系数
      u_fogA: { value: 0.03 },
      // 雾高度衰减系数
      u_fogB: { value: 0.285 },
    };
    // 地面材质
    const mat = new THREE.ShaderMaterial({
      // uniform 表
      uniforms: u,
      // 顶点（输出多组 varying）
      vertexShader: GROUND_VERT,
      // 片元（需要 getScatter / getBlueNoise / getLightUv 之外的工具）
      fragmentShader: withChunks(GROUND_FRAG),
      // 需要 dFdx/dFdy 做法线扰动（WebGL1 时代必须显式开启）
      extensions: { derivatives: true },
      // 双面：地形边缘/坑壁从内部看也要有颜色
      side: THREE.DoubleSide,
    });
    // 地形网格（几何来自 terrain.buf）
    this.groundMesh = new THREE.Mesh(this.terrainGeo, mat);
    // 顶点位移在 shader 里做，包围盒不可信
    this.groundMesh.frustumCulled = false;
    // 加入主场景
    this.scene.add(this.groundMesh);
  }

  // 远景光晕盒：包住场景的盒子，配合 HALO 着色器画背景散射
  _buildHalo() {
    // uniform：全局 + 两个显式比例（与 shared 指向同一对象）
    const u = {
      // 全局共享
      ...this.shared,
      // 场景可见比例
      u_sceneRatio: this.shared.u_sceneRatio,
      // HUD 比例
      u_hudRatio: this.shared.u_hudRatio,
    };
    // 光晕材质
    const mat = new THREE.ShaderMaterial({
      // uniform
      uniforms: u,
      // 顶点（把 z 推远）
      vertexShader: HALO_VERT,
      // 片元（散射）
      fragmentShader: withChunks(HALO_FRAG),
      // 不透明：靠 z 推到远平面保证顺序，不需要排序
      transparent: false,
      // 不写深度（不遮挡后面的雾/粒子）
      depthWrite: false,
      // 参与深度测试：被近处物体挡住时自动不画
      depthTest: true,
      // 双面：盒子从内部看也要有光晕
      side: THREE.DoubleSide,
    });
    // 背景盒网格
    this.haloMesh = new THREE.Mesh(this.bgBoxGeo, mat);
    // 渲染顺序 10：在粒子/岩石之后
    this.haloMesh.renderOrder = 10;
    // 盒子远大于视锥，不要剔除
    this.haloMesh.frustumCulled = false;
    // 加入主场景
    this.scene.add(this.haloMesh);
  }

  /* ── 雾片阵列（AboutHeroFog @1004394） ── */
  _buildFog() {
    // 雾片数量
    const COUNT = 32;
    // 原站 math.getSeedRandomFn('fog96')
    // 用字符串做 FNV-1a 哈希得到固定种子，保证每次刷新雾的布局一致（可复现）
    let seed = 2166136261;
    // 逐字符混入种子
    for (const ch of 'fog96') seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
    // mulberry32 伪随机：相同的种子永远产出相同的序列
    const rand = () => {
      // 强制 int32
      seed |= 0;
      // 线性递增（黄金比例常数）
      seed = (seed + 0x6d2b79f5) | 0;
      // 第一轮混合
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      // 第二轮混合（提升随机性）
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      // 归一化到 0..1
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // 3×3 细分面片：顶点的起伏由噪声驱动，细分够用来做曲面变形
    const plane = new THREE.PlaneGeometry(1, 1, 3, 3);
    // 实例化几何
    const geo = new THREE.InstancedBufferGeometry();
    // 面片基础属性
    for (const [k, v] of Object.entries(plane.attributes)) geo.setAttribute(k, v);
    // 索引
    geo.setIndex(plane.index);

    // 实例编号
    const ids = new Float32Array(COUNT);
    // 实例位置（x/z 分布在地面两侧，y 贴近地面）
    const pos = new Float32Array(COUNT * 3);
    // 实例随机数（旋转/速度/透明度）
    const rands = new Float32Array(COUNT * 3);
    // 逐片生成
    for (let i = 0, o = 0; i < COUNT; i++, o += 3) {
      // 编号
      ids[i] = i;
      // x：±12 内随机
      pos[o] = 12 * (rand() * 2 - 1);
      // y：-0.25 ~ 0.25，贴地形成雾带
      pos[o + 1] = -0.25 + 0.5 * rand();
      // z：从 +12 一路排到 -12（按 i 均匀分布），形成纵深感
      pos[o + 2] = 12 * (1 - (i / (COUNT - 1)) * 2);
      // 旋转相位
      rands[o] = rand() * 2 - 1;
      // 漂移速度
      rands[o + 1] = rand() * 2 - 1;
      // 透明度系数
      rands[o + 2] = rand() * 2 - 1;
    }
    // 注册实例属性：编号
    geo.setAttribute('a_instanceId', new THREE.InstancedBufferAttribute(ids, 1));
    // 注册实例属性：位置
    geo.setAttribute('a_instancePos', new THREE.InstancedBufferAttribute(pos, 3));
    // 注册实例属性：随机数
    geo.setAttribute('a_instanceRands', new THREE.InstancedBufferAttribute(rands, 3));

    // 雾之前场景的缓存 RT：片元要读背后像素的深度，所以在渲染雾之前先拷一份画面
    this.fogCacheRT = new THREE.WebGLRenderTarget(1, 1, {
      // 8 位够用（只读 g/b 用于比较）
      type: THREE.UnsignedByteType,
      // 线性放大
      minFilter: THREE.LinearFilter,
      // 线性缩小
      magFilter: THREE.LinearFilter,
      // 无深度
      depthBuffer: false,
    });

    // 雾材质
    const mat = new THREE.ShaderMaterial({
      // uniform：全局共享 + 雾贴图 + 场景缓存
      uniforms: {
        // 全局共享
        ...this.shared,
        // 雾贴图（r=密度 g=深度偏移）
        u_fogTexture: { value: this.fogTex },
        // 渲染雾之前的场景画面（每次绘制前拷贝）
        u_currSceneTexture: { value: this.fogCacheRT.texture },
      },
      // 顶点（长单行 GLSL，见 FOG_VERT）
      vertexShader: withChunks(FOG_VERT),
      // 片元（屏幕空间折射）
      fragmentShader: withChunks(FOG_FRAG),
      // 双面：雾片翻转时也要可见
      side: THREE.DoubleSide,
      // 不写深度：雾是叠加层
      depthWrite: false,
      // 透明
      transparent: true,
      // 自定义混合
      blending: THREE.CustomBlending,
      // 颜色：普通 alpha 混合
      blendEquation: THREE.AddEquation,
      // 源 alpha
      blendSrc: THREE.SrcAlphaFactor,
      // 目标 1-alpha
      blendDst: THREE.OneMinusSrcAlphaFactor,
      // alpha 也做加法
      blendEquationAlpha: THREE.AddEquation,
      // alpha 源因子 0
      blendSrcAlpha: THREE.ZeroFactor,
      // alpha 目标因子 1
      blendDstAlpha: THREE.OneFactor,
    });
    // 雾网格
    this.fogMesh = new THREE.Mesh(geo, mat);
    // 渲染顺序 20：最后画（在 HUD 线条之后）
    this.fogMesh.renderOrder = 20;
    // 顶点的位置由 shader 算，不剔除
    this.fogMesh.frustumCulled = false;

    // 片元要读"雾之前"的场景 g/b，渲染前把当前 RT 拷一份
    // 拷贝材质
    this._copyMaterial = new THREE.ShaderMaterial({
      // 来源（每次 onBeforeRender 重指）
      uniforms: { u_texture: { value: null } },
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // 直接采样
      fragmentShader: 'varying vec2 v_uv; uniform sampler2D u_texture; void main() { gl_FragColor = texture2D(u_texture, v_uv); }',
      // 无深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });
    // 拷贝 quad
    this._copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._copyMaterial);
    // 不剔除
    this._copyQuad.frustumCulled = false;
    // 拷贝专用场景
    this._copyScene = new THREE.Scene();
    // 入场景
    this._copyScene.add(this._copyQuad);

    // 雾绘制前：把当前渲染目标的内容拷进 fogCacheRT
    this.fogMesh.onBeforeRender = () => {
      // 当前绑定的渲染目标（通常是 composer 的 readBuffer）
      const rt = this.renderer.getRenderTarget();
      // 没有目标（直接画屏幕）就跳过
      if (!rt) return;
      // 输入换成当前画面
      this._copyMaterial.uniforms.u_texture.value = rt.texture;
      // 目标切到缓存 RT
      this.renderer.setRenderTarget(this.fogCacheRT);
      // 执行拷贝
      this.renderer.render(this._copyScene, this.shadowCamera);
      // 还原目标，继续渲染雾
      this.renderer.setRenderTarget(rt);
    };
    // 加入主场景
    this.scene.add(this.fogMesh);
  }

  /* ── 屏幕空间运动模糊：1/4 分辨率渲染粒子速度 + 可分离 9-tap（原站 efxPrepass.renderMotion） ── */
  _renderMotionBlur(aspect) {
    // 粒子系统（提供 motionScene / motionUniforms）
    const p = this.particles;
    // 未就绪就跳过
    if (!p?.motionScene) return;
    // 渲染器简写
    const r = this.renderer;
    // 速度图宽 = 画布宽 / 4（右移 2 位）
    const mw = Math.max(1, r.domElement.width >> 2);
    // 速度图高 = 画布高 / 4
    const mh = Math.max(1, r.domElement.height >> 2);
    // 尺寸变化时重建两张 RT
    if (this.motionRT.width !== mw || this.motionRT.height !== mh) {
      // 速度图 RT
      this.motionRT.setSize(mw, mh);
      // 模糊中转 RT
      this.motionTmpRT.setSize(mw, mh);
    }
    // 预通道要采样的速度纹理
    this.preMotionMat.uniforms.u_motionTexture.value = this.motionRT.texture;

    // 把屏幕宽高比传给拖尾顶点（速度方向要按像素空间算）
    p.motionUniforms.u_aspect.value = aspect;
    // 保存调用前的渲染目标
    const prev = r.getRenderTarget();

    // 切到速度 RT
    r.setRenderTarget(this.motionRT);
    // 清深度（拖尾面片需要正确前后遮挡）
    r.clearDepth();
    // 用中性色材质「清」颜色：0.5 代表零速度（不能用 setClearColor，会被 sRGB 转换）
    this._fsQuad.material = this._motionClearMat;
    // 全屏写入中性色
    r.render(this._fsScene, this.shadowCamera);
    // 渲染所有粒子的拖尾面片（速度编码进颜色）
    r.render(p.motionScene, this.camera);

    // 水平模糊：输入速度图
    this._fsQuad.material = this.blurMat;
    // 输入纹理
    this.blurMat.uniforms.u_texture.value = this.motionRT.texture;
    // 水平步长（0.5 像素）
    this.blurMat.uniforms.u_delta.value.set(0.5 / mw, 0);
    // 目标切到中转 RT
    r.setRenderTarget(this.motionTmpRT);
    // 执行
    r.render(this._fsScene, this.shadowCamera);

    // 垂直模糊：输入中转结果
    this.blurMat.uniforms.u_texture.value = this.motionTmpRT.texture;
    // 垂直步长
    this.blurMat.uniforms.u_delta.value.set(0, 0.5 / mh);
    // 写回速度 RT
    r.setRenderTarget(this.motionRT);
    // 执行
    r.render(this._fsScene, this.shadowCamera);

    // 还原渲染目标
    r.setRenderTarget(prev);
  }

  /* ── 每帧：把岩石投影进光源阴影图 ── */
  _renderLightShadow() {
    // 渲染器简写
    const r = this.renderer;
    // 保存渲染目标
    const prev = r.getRenderTarget();
    // 保存清屏色
    const prevColor = r.getClearColor(new THREE.Color());
    // 保存清屏 alpha
    const prevAlpha = r.getClearAlpha();
    // 切到阴影图 RT
    r.setRenderTarget(this.lightShadowRT);
    // 白色 = 距离 1（最远 / 无遮挡）
    r.setClearColor(0xffffff, 1);
    // 清颜色与深度（深度用于保留最近遮挡）
    r.clear(true, true, false);
    // 关闭自动清色，逐个 mesh 累积渲染（避免每个 mesh 前都清屏）
    r.autoClearColor = false;
    // 逐个渲染岩石阴影网格（低模 + IS_SHADOW 分支）
    for (const m of this.rockShadowMeshes || []) r.render(m, this.shadowCamera);
    // 恢复自动清色
    r.autoClearColor = true;
    // 还原渲染目标
    r.setRenderTarget(prev);
    // 还原清屏色
    r.setClearColor(prevColor, prevAlpha);
  }

  /* ── 每帧：8-tap 采样光源阴影图，累积到地面软阴影 RT ── */
  _updateGroundShadow() {
    // 未构建时跳过
    if (!this.gShadowRT) return;
    // 渲染器简写
    const r = this.renderer;
    // 保存渲染目标
    const prev = r.getRenderTarget();
    // 保存清屏色
    const prevColor = r.getClearColor(new THREE.Color());
    // 保存清屏 alpha
    const prevAlpha = r.getClearAlpha();
    // 读缓冲（上一帧累积结果）
    const from = this.gShadowRT[this.gShadowIdx];
    // 写缓冲（本帧）
    const to = this.gShadowRT[1 - this.gShadowIdx];
    // 上一帧纹理作为输入
    this.gShadowUniforms.u_prevTexture.value = from.texture;
    // 每帧随机蓝噪声偏移（打散 8-tap 的规则采样，把条带变成噪点）
    this.gShadowUniforms.u_blueNoiseOffset.value.set((Math.random() * 128) | 0, (Math.random() * 128) | 0);
    // 切到写缓冲
    r.setRenderTarget(to);
    // 白色底（无遮挡）
    r.setClearColor(0xffffff, 1);
    // 只清颜色
    r.clear(true, false, false);
    // 跑累积 pass
    r.render(this.gShadowScene, this.shadowCamera);
    // 还原渲染目标
    r.setRenderTarget(prev);
    // 还原清屏色
    r.setClearColor(prevColor, prevAlpha);
    // 交换索引（下一帧读写互换）
    this.gShadowIdx = 1 - this.gShadowIdx;
    // 地形采样最新的阴影图
    this.groundMesh.material.uniforms.u_groundShadowTexture.value = to.texture;
  }

  /* ── 粒子星云 + 体积光照场（AboutHeroParticles @966600） ── */
  async _buildParticles() {
    // 粒子系统：需要 renderer / 主场景 / shared / chunk 注入
    this.particles = new AboutHeroParticles({
      // 渲染器：所有 GPGPU pass 都用它
      renderer: this.renderer,
      // 主场景：粒子容器会被加入
      scene: this.scene,
      // 全局共享 uniform
      shared: this.shared,
      // chunk 注入
      withChunks,
    });
    // 等待 sim / 光照场 / 网格全部就绪
    await this.particles.load();
  }

  /* ── LUSION 标题：读取项目里的 logo_text.buf（可用 /logo 页面重新生成并应用） ── */
  async _buildLogo() {
    // 标题网格：x∈[0,1] 归一化字宽，z=1 填充 / z=0 抗锯齿裙边，char=字序号
    const geo = await loadBuf('/assets/models/about/logo_text.buf');
    // 计算包围盒（求宽高比）
    geo.computeBoundingBox();
    // 包围盒简写
    const bb = geo.boundingBox;
    // 宽高比：防止 0 高度导致除零
    const aspect = (bb.max.x - bb.min.x) / Math.max(1e-6, bb.max.y - bb.min.y);
    // 逐顶点字序号属性
    const ch = geo.getAttribute('char');
    // 最大字序号（至少 1，避免后面除零）
    let charMax = 1;
    // 遍历求最大值
    if (ch) {
      // 逐顶点比较
      for (let i = 0; i < ch.count; i++) charMax = Math.max(charMax, ch.getX(i));
    }

    // 标题专用 uniform
    this.logoUniforms = {
      // 入场比例（时间驱动）
      u_showRatio: { value: 0 },
      // 退场/morph 比例（滚动驱动）
      u_hideRatio: { value: 0 },
      // 字形宽高比
      u_aspect: { value: aspect },
      // 最大字序号
      u_charMax: { value: Math.max(1, charMax) },
      // 视口尺寸（像素）
      u_resolution: { value: new THREE.Vector2(1, 1) },
      // 主标题 DOM rect
      u_domXY: { value: new THREE.Vector2() },
      // 主标题 DOM 尺寸
      u_domWH: { value: new THREE.Vector2() },
      // DOM 中心（保留）
      u_domPivot: { value: new THREE.Vector2() },
      // 退场目标 DOM rect
      u_toDomXY: { value: new THREE.Vector2() },
      // 退场目标 DOM 尺寸
      u_toDomWH: { value: new THREE.Vector2() },
    };
    // 标题网格
    this.logoMesh = new THREE.Mesh(
      // 几何
      geo,
      // 材质：纯白 + 抗锯齿 alpha
      new THREE.ShaderMaterial({
        // uniform
        uniforms: this.logoUniforms,
        // 顶点：DOM 对齐 + 两段动画
        vertexShader: LOGO_VERT,
        // 片元：fwidth 抗锯齿
        fragmentShader: LOGO_FRAG,
        // 透明
        transparent: true,
        // 关深度：标题是叠在最终画面上的 DOM 替代品
        depthTest: false,
        // 不写深度
        depthWrite: false,
        // 双面
        side: THREE.DoubleSide,
      })
    );
    // 顶点直接写裁剪空间，不剔除
    this.logoMesh.frustumCulled = false;
    // 渲染顺序 10
    this.logoMesh.renderOrder = 10;
    // 独立场景：后期完成后再单独 render 到屏幕
    this.logoScene = new THREE.Scene();
    // 入场景
    this.logoScene.add(this.logoMesh);
  }

  /* ── HUD：地形线条 + 字母层（AboutHeroLines @990477 / AboutHeroLetters @1023429） ── */
  async _buildHud() {
    // HUD 模块：线条 + 字母层
    this.hud = new AboutHeroHud({
      // 渲染器（离屏字母层要用）
      renderer: this.renderer,
      // 相机（字母以同一视角渲染，保证对齐）
      camera: this.camera,
      // 全局共享 uniform
      shared: this.shared,
      // chunk 注入
      withChunks,
      // 字体图集
      fontTexture: this.shared.u_letterTexture.value,
    });
    // 等两份 buf 加载 + 几何构建完成
    await this.hud.load();
    // HUD 容器加入主场景
    this.scene.add(this.hud.container);
  }

  /* ── 宇航员：54 骨骼蒙皮 + 85 帧 idle 动画 ── */
  async _buildPerson() {
    // 资源根路径
    const BASE = '/assets/';
    // 骨骼数量（与 person.buf 的顶点属性一致，也决定 uniform 数组长度）
    const BONE_COUNT = 54;
    // 动画帧率（person_idle.buf 按 60fps 烘焙）
    const FPS = 60;

    // 并行加载网格 / 动画 / 三张贴图
    const [geo, anim, lightTex, baseTex, shadowTex] = await Promise.all([
      // 蒙皮网格：position / normal / uv / boneIndices / boneWeights
      loadBuf(BASE + 'models/about/person.buf'),
      // 骨骼动画：每帧每骨的 position + orient（四元数）
      loadBuf(BASE + 'models/about/person_idle.buf'),
      // 三相位光照贴图（rgb）
      new THREE.TextureLoader().loadAsync(BASE + 'textures/about/person_light.webp'),
      // 人物明暗遮罩（只取 r）
      new THREE.TextureLoader().loadAsync(BASE + 'textures/about/person.webp'),
      // 地面投影贴图
      new THREE.TextureLoader().loadAsync(BASE + 'textures/about/ground_person_shadow.webp'),
    ]);

    // 合并 person_light.rgb + person.r → RGBA
    // 目标 RT：尺寸跟随光照贴图，开 mipmap（人物会缩小，需要 mip 防闪烁）
    const mergeRT = new THREE.WebGLRenderTarget(lightTex.image.width, lightTex.image.height, {
      // 8 位够用
      type: THREE.UnsignedByteType,
      // 自动生成 mipmap
      generateMipmaps: true,
      // 三线性过滤
      minFilter: THREE.LinearMipmapLinearFilter,
      // 线性放大
      magFilter: THREE.LinearFilter,
    });
    // 合并材质
    const mergeMat = new THREE.ShaderMaterial({
      // 两张输入
      uniforms: { u_light: { value: lightTex }, u_base: { value: baseTex } },
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // rgb 取自光照图，a 取自明暗图
      fragmentShader: MERGE_FRAG,
      // 无深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });
    // 全屏 quad
    const mergeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mergeMat);
    // 不剔除
    mergeQuad.frustumCulled = false;
    // 专用场景
    const mergeScene = new THREE.Scene();
    // 入场景
    mergeScene.add(mergeQuad);
    // 保存当前渲染目标
    const prevRT = this.renderer.getRenderTarget();
    // 切到合并 RT
    this.renderer.setRenderTarget(mergeRT);
    // 执行合并
    this.renderer.render(mergeScene, this.shadowCamera);
    // 还原
    this.renderer.setRenderTarget(prevRT);
    // 释放临时 quad
    mergeQuad.geometry.dispose();
    // 释放临时材质
    mergeMat.dispose();

    // 骨骼位置数组（每帧由 _updatePerson 写入，直接映射到 uniform 数组）
    const bonePoses = new Float32Array(BONE_COUNT * 3);
    // 骨骼朝向四元数数组
    const boneOrients = new Float32Array(BONE_COUNT * 4);
    // 初始化为单位四元数（w=1），否则未更新的骨骼会得到全零四元数导致模型塌缩
    for (let i = 0; i < BONE_COUNT; i++) boneOrients[i * 4 + 3] = 1;

    // 人物材质 uniform
    const uniforms = {
      // 全局共享
      ...this.shared,
      // 合并后的 RGBA 贴图
      u_texture: { value: mergeRT.texture },
      // 三相位光照权重（每帧按动画帧更新）
      u_lightMixer: { value: new THREE.Vector3(1, 0, 0) },
      // 骨骼位置（与 bonePoses 同一个 Float32Array）
      u_bonePoses: { value: bonePoses },
      // 骨骼朝向（与 boneOrients 同一个 Float32Array）
      u_boneOrients: { value: boneOrients },
    };
    // 保存，_updatePerson 每帧改 u_lightMixer 并写骨骼数组
    this.personUniforms = uniforms;

    // 人物材质
    const mat = new THREE.ShaderMaterial({
      // uniform
      uniforms,
      // 双骨蒙皮顶点
      vertexShader: PERSON_VERT,
      // 片元（需 getScatter）
      fragmentShader: withChunks(PERSON_FRAG),
      // 注入骨骼数量（uniform 数组长度必须是编译期常量）
      defines: { BONE_COUNT },
    });
    // 人物网格
    const mesh = new THREE.Mesh(geo, mat);
    // 顶点在 shader 里做蒙皮，包围盒不可信
    mesh.frustumCulled = false;
    // 加入主场景
    this.scene.add(mesh);

    // 地面投影材质
    const shadowMat = new THREE.ShaderMaterial({
      // 投影贴图 + 复用同一份光照权重 + 全局共享
      uniforms: { u_texture: { value: shadowTex }, u_lightMixer: uniforms.u_lightMixer, ...this.shared },
      // 普通顶点（面片贴地）
      vertexShader: PERSON_SHADOW_VERT,
      // 片元（蓝噪声 + 相位混合）
      fragmentShader: withChunks(PERSON_SHADOW_FRAG),
      // 原站（three r158）的 MultiplyBlending 等价于 dst * src；r187 起必须显式 CustomBlending
      blending: THREE.CustomBlending,
      // 加法步进
      blendEquation: THREE.AddEquation,
      // 源因子 0（颜色不参与）
      blendSrc: THREE.ZeroFactor,
      // 目标因子 = 源色 → dst*src
      blendDst: THREE.SrcColorFactor,
      // alpha 加法
      blendEquationAlpha: THREE.AddEquation,
      // alpha 源因子 0
      blendSrcAlpha: THREE.ZeroFactor,
      // alpha 目标因子 = 源 alpha
      blendDstAlpha: THREE.SrcAlphaFactor,
      // 透明
      transparent: true,
      // 不写深度（贴在地面上）
      depthWrite: false,
    });
    // 投影面片：1.5×1.5
    const shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), shadowMat);
    // 渲染顺序 10：在地面之后
    shadowMesh.renderOrder = 10;
    // 抬高 0.01 避免与地面 z-fighting
    shadowMesh.position.y = 0.01;
    // 平铺到地面（绕 X 轴 -90°）
    shadowMesh.rotation.x = -Math.PI / 2;
    // 加入场景
    this.scene.add(shadowMesh);

    // 人物动画状态（供 _updatePerson 使用）
    this.person = {
      // 骨骼位置缓冲（uniform 直接引用）
      bonePoses,
      // 骨骼朝向缓冲
      boneOrients,
      // 每帧每骨的位置数据
      posData: anim.attributes.position.array,
      // 每帧每骨的朝向数据
      orientData: anim.attributes.orient.array,
      // 总帧数 = 数据长度 /（骨骼数 × 3）
      frameCount: anim.attributes.position.array.length / (BONE_COUNT * 3),
      // 帧率
      fps: FPS,
      // 骨骼数
      boneCount: BONE_COUNT,
      // 当前动画时间（秒，减速版）
      time: 0,
    };
  }

  /* 原站 aboutHeroPerson.update：time += dt*0.5，帧循环 + 骨骼 lerp/slerp + 三相位光照混合 */
  _updatePerson(dt) {
    // 人物状态
    const p = this.person;
    // 未构建就跳过
    if (!p) return;
    // 动画时间推进：0.5 倍速让 idle 更缓慢
    p.time += dt * 0.5;
    // 当前帧号（浮点，循环）
    const t = (p.time * p.fps) % p.frameCount;
    // 前一帧
    const i0 = Math.floor(t);
    // 后一帧（到末帧回绕到第 0 帧，实现无缝循环）
    const i1 = Math.ceil(t) % p.frameCount;
    // 两帧之间的插值权重
    const a = t - i0;
    // i0 帧在数据数组中的起始下标（每帧 boneCount 个骨）
    const o0 = i0 * p.boneCount;
    // i1 帧的起始下标
    const o1 = i1 * p.boneCount;
    // 把动画均分为三段（三相位光照对应的区间长度）
    const u = p.frameCount / 3;

    // 光照权重向量
    const mixer = this.personUniforms.u_lightMixer.value;
    // 三个通道分别做「进入 / 保持 / 退出」的三角权重：
    //   r：从第 3 段末尾淡回第 1 段（首尾相接），并在第 1 段内淡出
    //   g：第 1 段淡入 × 第 2 段淡出
    //   b：第 2 段淡入 × 第 3 段淡出
    mixer.set(
      // r 相位
      fit(t, u * 2, p.frameCount, 0, 1) + fit(t, 0, u, 1, 0),
      // g 相位
      fit(t, 0, u, 0, 1) * fit(t, u, u * 2, 1, 0),
      // b 相位
      fit(t, u, u * 2, 0, 1) * fit(t, u * 2, p.frameCount, 1, 0)
    );

    // 复用向量：起始骨骼位置
    const v1 = this._pv1 || (this._pv1 = new THREE.Vector3());
    // 复用向量：目标骨骼位置
    const v2 = this._pv2 || (this._pv2 = new THREE.Vector3());
    // 复用四元数：起始朝向
    const q1 = this._pq1 || (this._pq1 = new THREE.Quaternion());
    // 复用四元数：目标朝向
    const q2 = this._pq2 || (this._pq2 = new THREE.Quaternion());
    // 逐骨插值
    for (let b = 0; b < p.boneCount; b++) {
      // 位置线性插值（i0 → i1，权重 a）
      v1.fromArray(p.posData, (o0 + b) * 3).lerp(v2.fromArray(p.posData, (o1 + b) * 3), a);
      // 写回 uniform 数组（GPU 下一帧直接读）
      v1.toArray(p.bonePoses, b * 3);
      // 朝向球面插值（四元数必须 slerp，lerp 会破坏长度）
      q1.fromArray(p.orientData, (o0 + b) * 4).slerp(q2.fromArray(p.orientData, (o1 + b) * 4), a);
      // 写回 uniform 数组
      q1.toArray(p.boneOrients, b * 4);
    }
  }

  /* ── 相机：沿 camera_spline 推进（原站 AboutHero.syncProperties） ── */
  _updateCamera(initialSplineRatio) {
    // 样条位置数组（每点 3 个 float）
    const P = this.spline.attributes.position.array;
    // 样条朝向数组（每点一个四元数）
    const Q = this.spline.attributes.orient.array;
    // 样条点总数
    const count = P.length / 3;
    // 把 0..1 映射到 0..149 段（原站只用前 149 段，末尾保留）
    const t = saturate(initialSplineRatio) * Math.min(149, count - 1);
    // 前一个关键点
    const i = Math.floor(t);
    // 后一个关键点
    const j = Math.min(count - 1, Math.ceil(t));
    // 两点之间的插值权重
    const a = t - i;

    // 位置线性插值
    const p = new THREE.Vector3().fromArray(P, i * 3).lerp(new THREE.Vector3().fromArray(P, j * 3), a);
    // 起始朝向四元数
    const q0 = new THREE.Quaternion().fromArray(Q, i * 4);
    // 目标朝向四元数
    const q1 = new THREE.Quaternion().fromArray(Q, j * 4);
    // 球面插值
    q0.slerp(q1, a);

    // 朝向的四元数作用到 +Z 轴上，再加上位置 = 注视点
    const look = new THREE.Vector3(0, 0, 1).applyQuaternion(q0).add(p);
    // 相机位置
    this.camera.position.copy(p);
    // 相机看向注视点
    this.camera.lookAt(look);
    // 原站 CameraControls：鼠标 look 偏移（cameraLookStrength .1 / easeDamp .1）
    // 俯仰偏移：鼠标 y × 0.1，钳到 ±1 后取 0.1 弧度
    const lookTX = Math.min(1, Math.max(-1, this._mouse.y)) * 0.1;
    // 偏航偏移：鼠标 x 取反 × 0.1
    const lookTY = Math.min(1, Math.max(-1, -this._mouse.x)) * 0.1;
    // 一阶阻尼（每帧靠近目标 10%）→ 柔和跟随
    this._lookX += (lookTX - this._lookX) * 0.1;
    // 同上，偏航
    this._lookY += (lookTY - this._lookY) * 0.1;
    // 组装欧拉角
    this._lookEuler.set(this._lookX, this._lookY, 0);
    // 转四元数
    this._lookQuat.setFromEuler(this._lookEuler);
    // 叠加到相机当前朝向（局部旋转）
    this.camera.quaternion.multiply(this._lookQuat);
    // 保持 roll 为 0（避免累积倾斜）
    this.camera.rotateZ(0);
  }

  // 每帧主循环：算 dt → 算滚动编排比例 → 相机 → uniform → 各系统更新 → 后期 → DOM
  _renderFrame() {
    // 当前时间戳（毫秒）
    const now = performance.now();
    // 帧间隔（秒）
    let dt = (now - this._lastT) / 1000;
    // 记录本帧时间戳
    this._lastT = now;
    // 非法值（首帧/切标签页回来）归零
    if (!Number.isFinite(dt)) dt = 0;
    // 上限 50ms：防止长时间挂起后一帧跳太远导致粒子穿透
    dt = Math.min(dt, 0.05);
    // 全局时间累加
    this._time += dt;

    // 子弹时间：按住鼠标 → freezeRatio→(1-hudRatio)，粒子/光照场时间降到 10%
    // 一阶阻尼逼近目标（按住时目标为 1-hudRatio，HUD 阶段自动失效）
    this.freezeRatio += ((this._pointerDown ? 1 - this.shared.u_hudRatio.value : 0) - this.freezeRatio) * 0.1;
    // 减速后的 dt：freezeRatio=1 时缩到 10%（0.1），=0 时原速
    const frozenDt = dt * (1 + (0.1 - 1) * this.freezeRatio);
    // 入场时间轴（受减速影响）
    this.introTime += frozenDt;

    // 画布逻辑宽度（CSS 像素）
    const W = this.renderer.domElement.width / this.renderer.getPixelRatio();
    // 画布逻辑高度
    const H = this.renderer.domElement.height / this.renderer.getPixelRatio();
    // 视口宽度（滚动编排的基准单位）
    const vw = Math.max(1, window.innerWidth);

    // 滚动编排（u 以「视口宽」为单位）
    // u = scrollY / viewportWidth：与屏幕宽度无关的滚动进度
    const u = this._scrollY / vw;
    // 相机沿样条推进：0..5.25 屏宽走完 0..1（等价原站 149/200 段）
    const initialSplineRatio = fit(u, 0, 5.25, 0, 1);
    // 入场进度：u/5.25 钳到 0..1（驱动淡入 / 散射 / 岩石尺度）
    const introRatio = saturate(u / 5.25);
    // HUD 退场比例：5.25..6.125 屏宽之间 0→1
    const hudRatio = fit(u, 5.25, 6.125, 0, 1);

    // 场景整体可见比例：introRatio 0.01..0.1 之间用 cubicOut 淡入
    const sceneRatio = fit(introRatio, 0.01, 0.1, 0, 1, ease.cubicOut);

    // 相机位置/朝向（样条插值 + 鼠标 look 偏移）
    this._updateCamera(initialSplineRatio);

    // 相机 FOV：原站 60 + dolly offset（sineInOut）
    this.camera.fov = 60 + this._dolly(initialSplineRatio);
    // 宽高比
    this.camera.aspect = vw / Math.max(1, H);
    // 应用投影矩阵（改 fov/aspect 后必须重算）
    this.camera.updateProjectionMatrix();

    // 散射（光柱）参数
    // 共享 uniform 简写
    const share = this.shared;
    // 第一步：入场 0..0.2 把幂次从 2 收到 0.7（光柱由细变粗）
    let powInv = fit(introRatio, 0, 0.2, 2, 0.7);
    // 第二步：0.7..0.85 继续收到 0.4（HUD 前最后一次收紧）
    powInv = fit(introRatio, 0.7, 0.85, powInv, 0.4);
    // 写入散射幂次倒数
    share.u_lightScatterPowInv.value = powInv;
    // 散射强度：0.7..0.85 之间用 cubicIn 从 1 收到 0
    share.u_lightScatterRatio.value = fit(introRatio, 0.7, 0.85, 1, 0, ease.cubicIn);
    // 场景可见比例
    share.u_sceneRatio.value = sceneRatio;
    // HUD 比例
    share.u_hudRatio.value = hudRatio;
    // 场景隐藏比例：0.85..1 之间收拢（HUD 前把场景压掉）
    share.u_sceneHideRatio.value = fit(introRatio, 0.85, 1, 0, 1);
    // 入场时间
    share.u_introTime.value = this.introTime;
    // 入场 dt
    share.u_introDeltaTime.value = frozenDt;
    // 全局时间（不减速）
    share.u_time.value = this._time;
    // 分辨率（物理像素，后处理 pass 用）
    share.u_resolution.value.set(this.renderer.domElement.width, this.renderer.domElement.height);
    // u_noiseStableFactor 由粒子模拟（sim）每帧写入，与原站一致
    // 粒子未就绪时兜底用一个缓慢正弦值，避免其它材质读到 0 导致画面死板
    if (!this.particles) share.u_noiseStableFactor.value = 0.5 + 0.5 * Math.sin(this._time * 0.35);

    // 散射光源轻微布朗运动（原站 BrownianMotion）
    // 时间简写
    const t = this._time;
    // 上端点：三个不同频率的正弦叠加 → 无周期的柔和漂移
    this.scatterPos0.set(Math.sin(t * 0.31) * 0.35, 18 + Math.sin(t * 0.23) * 0.4, Math.cos(t * 0.27) * 0.35);
    // 下端点同理（相位错开 1.7 / 2.1）
    this.scatterPos1.set(Math.sin(t * 0.19 + 1.7) * 0.28, Math.sin(t * 0.17) * 0.55, Math.cos(t * 0.21 + 2.1) * 0.28);

    // bloom：原站三段插值
    // 基准强度
    let bloomAmount = 3;
    // 第一段：0.1..0.85 从 3 降到 1.5（画面稳定后收掉泛光）
    bloomAmount = fit(introRatio, 0.1, 0.85, bloomAmount, 1.5);
    // 第二段：0.85..1 快速升到 10（进入 HUD 时爆亮）
    bloomAmount = fit(introRatio, 0.85, 1, bloomAmount, 10);
    // 写入泛光强度
    this.bloom.amount = bloomAmount;
    // 半径（GoalBloom 内部参数）
    this.bloom.radius = 0;
    // 饱和度
    this.bloom.saturation = 1;
    // 高光阈值倍数
    this.bloom.highPassMultiplier = 1;
    // 光晕宽度
    this.bloom.haloWidth = 0.6;
    // 光晕 RGB 偏移（色散）
    this.bloom.haloRGBShift = 0.02;
    // 光晕强度：HUD 阶段 0.5 内收到 0，否则由 introRatio 0.1..0.4 决定（0.08→0.15）
    this.bloom.haloStrength = fit(hudRatio, 0, 0.5, fit(introRatio, 0.1, 0.4, 0.08, 0.15), 0);
    // 光晕遮罩内径
    this.bloom.haloMaskInner = 0.3;
    // 光晕遮罩外径
    this.bloom.haloMaskOuter = 0.5;

    // 屏幕空间运动模糊（原站 motionBlurRatio：1 → 1.5 → 0）
    // 入场 0..0.1 从 1 提到 1.5（飞入时拖尾最长）
    let motionRatio = fit(introRatio, 0, 0.1, 1, 1.5);
    // 0.1..0.15 迅速归 0（落定后关闭）
    motionRatio = fit(introRatio, 0.1, 0.15, motionRatio, 0);

    // HUD 人像特效已剔除：线条随 hudRatio 出现，不再有人脸叠加与 HUD 配色偏移
    // 线条只在 hudRatio > 0 时绘制
    if (this.hud?.lineMesh) this.hud.lineMesh.visible = hudRatio > 0;
    // 线条显影比例（shader 里按比例自上而下画出）
    share.u_showRatio.value = hudRatio;

    // 原站 AboutPageHeroEfx：保持场景配色（不再向 HUD 蓝绿配色插值）
    // efx 调色的 uniform
    const efxU = this.efxPass.uniforms;
    // HUD 配色权重固定 0（人脸/HUD 配色方案已移除）
    const hudE = 0;
    // burn 色 = 场景色（lerp 到 HUD 色但权重 0）
    efxU.u_colorBurn.value.copy(this._sceneBurn).lerp(this._hudBurn, hudE);
    // dodge 色同理
    efxU.u_colorDodge.value.copy(this._sceneDodge).lerp(this._hudDodge, hudE);
    // burn 强度 0.15 → 1.0（按 hudE² 插值）
    efxU.u_colorBurnAlpha.value = mix(0.15, 1.0, hudE * hudE);
    // dodge 强度 0.12 → 0.7
    efxU.u_colorDodgeAlpha.value = mix(0.12, 0.7, hudE * hudE);

    // efxPrepass 材质选择：运动模糊 > HUD 径向模糊 > 纯灰度
    // 入场阶段优先运动模糊
    if (motionRatio > 0) {
      // 换成运动模糊材质
      this.preEfxPass.use(this.preMotionMat);
      // 写入模糊比例
      this.preMotionMat.uniforms.u_blurRatio.value = motionRatio;
    // 否则若有 HUD 比例，用径向模糊
    } else if (hudRatio > 0) {
      // 换成 HUD 径向模糊材质
      this.preEfxPass.use(this.preHudBlurMat);
      // 模糊比例 = hudRatio
      this.preHudBlurMat.uniforms.u_blurRatio.value = hudRatio;
      // 宽高比（径向采样要按屏幕比例）
      this.preHudBlurMat.uniforms.u_aspect.value = W / H;
    // 其余情况用最便宜的灰度通道
    } else {
      // 默认灰度
      this.preEfxPass.use(this.preBaseMat);
    }
    // 不叠加额外场景（人脸层已移除）
    this.preEfxPass.overlayScene = null;

    // 粒子：sim → 光照场（图集清空 / 点渲染 / 模糊累积），必须先于岩石（共享 noiseStableFactor）
    // 传未减速 dt 给 sim、frozenDt 给光照场
    this.particles?.update(dt, introRatio, hudRatio, frozenDt);

    // 屏幕空间运动模糊
    // 有比例且粒子就绪才渲染速度图
    if (motionRatio > 0 && this.particles) {
      // 渲染 1/4 分辨率速度图 + 两次可分离模糊
      this._renderMotionBlur(W / H);
    }

    // 岩石：原站 aboutHeroRocks.update(t) —— 子弹时间同样减速；u_globalTime 不减速
    // 整体尺度：0..0.2 从 0 长到 1
    const rockScale = fit(introRatio, 0, 0.2, 0, 1);
    // 逐个模型（4 组共享 uniform 结构，但各自独立）
    for (const u of this.rockUniforms || []) {
      // 循环时间用减速 dt（子弹时间生效）
      u.u_time.value += frozenDt;
      // 全局时间不减速（漂浮感不随慢动作停止）
      u.u_globalTime.value = this._time;
      // 尺度
      u.u_scale.value = rockScale;
    }

    // 岩石投影进光源阴影图
    this._renderLightShadow();
    // 8-tap 累积地面软阴影
    this._updateGroundShadow();
    // 人物骨骼动画（减速 dt）
    this._updatePerson(frozenDt);

    // 清屏（原站 clearAlpha 0）
    // 渲染目标切回屏幕
    this.renderer.setRenderTarget(null);
    // 黑色透明底
    this.renderer.setClearColor(0x000000, 0);
    // 颜色 + 深度 + 模板全清（autoClear=false，必须手动清）
    this.renderer.clear(true, true, true);
    // 跑后期链：RenderPass → preEfx → bloom → efx
    this.composer.render(dt);

    // 原站 WhoSubsectionWeAre：logoHideRatio 时间驱动（introRatio < .05 时回 0）
    // 每秒 ±1 增减，滚回顶部会重新展开标题
    this._logoHide = saturate(this._logoHide + dt * (introRatio < 0.05 ? -1 : 1));
    // 把 DOM rect / show / hide 写进标题材质
    this._updateLogo(hudRatio);

    // LUSION 标题：后期完成后再叠到画布上（原站 postUfxContainer）
    // 标题可见时单独渲染一次
    if (this.logoMesh?.visible) {
      // 目标回到屏幕（覆盖刚刚的后期结果）
      this.renderer.setRenderTarget(null);
      // 只渲染标题场景
      this.renderer.render(this.logoScene, this.camera);
    }

    // 更新 DOM 层（滚动提示透明度、十字标记）
    this._updateDom(u, introRatio, hudRatio, dt);
  }

  /** 原站 cameraDollyZoomFovOffset = fit(initialSplineRatio, .4, .8, 0, -10, sineInOut) */
  _dolly(r) {
    // 把样条进度 0.4..0.8 归一化到 0..1（超过 1 截断）
    const k = saturate((r - 0.4) / 0.4);
    // 正弦缓动到 -10°，形成推轨（dolly zoom）式的视野变化
    return mix(0, -10, ease.sineInOut(k));
  }

  // DOM 联动：滚动提示淡出 + 十字标记淡入
  _updateDom(u, introRatio, hudRatio, dt) {
    // 首屏层
    const { introEl } = this.els;
    // 存在才处理
    if (introEl) {
      // 只查一次 .intro-scroll，之后缓存
      const label = this._labelEl || (this._labelEl = introEl.querySelector('.intro-scroll'));
      // 找到才更新样式
      if (label) {
        // 原站：opacity = fit(logoHideRatio, 0, .35, 1, 0, cubicInOut)，translateY (1-ratio)*120%
        // 标题越退场，提示越透明
        const f = fit(this._logoHide, 0, 0.35, 1, 0, ease.cubicInOut);
        // 写入透明度
        label.style.opacity = String(f);
        // 同时向下位移（1-f 越大越靠下，最多 120%）
        label.style.transform = `translate3d(0, ${(1 - f) * 120}%, 0)`;
      }
    }
    // 十字标记在舞台层
    const crosses = this.host?.parentElement?.querySelector('.crosses');
    // 0.35..0.6 淡入到 0.9，HUD 阶段淡出
    if (crosses) crosses.style.opacity = String(fit(introRatio, 0.35, 0.6, 0, 0.9) * (1 - hudRatio));
  }

  /** 原站 AboutWhoLogo.update：每帧把 DOM rect / show / hide 写进 logo 材质 */
  _updateLogo(hudRatio) {
    // 未构建就跳过
    if (!this.logoMesh || !this.logoUniforms) return;
    // 锚点 DOM
    const el = this.els.logoEl;
    // 视口宽（至少 1）
    const vw = Math.max(1, window.innerWidth);
    // 视口高
    const vh = Math.max(1, window.innerHeight);
    // uniform 简写
    const U = this.logoUniforms;
    // 有锚点元素才对齐
    if (el) {
      // 读取实时布局位置（滚动/缩放都会变）
      const r = el.getBoundingClientRect();
      // 左上角
      U.u_domXY.value.set(r.left, r.top);
      // 宽高
      U.u_domWH.value.set(r.width, r.height);
      // 中心点（预留）
      U.u_domPivot.value.set(r.width * 0.5, r.height * 0.5);
    }
    // 原站 #about-who-title-left-2 在 1280×800 下为 left 67.8 / top 586 / 180.8×36.3
    // 换算成视口比例后写死，作为标题 morph 的终点
    U.u_toDomXY.value.set(vw * 0.053, vh * 0.7325);
    // 目标尺寸按视口比例
    U.u_toDomWH.value.set(vw * 0.1412, vh * 0.0454);
    // 视口尺寸（裁剪空间换算）
    U.u_resolution.value.set(vw, vh);
    // 入场比例：1.5s 内从 0 到 1（时间驱动，不受滚动影响）
    U.u_showRatio.value = fit(this._time, 0.5, 1.5, 0, 1);
    // morph 比例：滚动驱动
    U.u_hideRatio.value = this._logoHide;
    // 进入 HUD 或完全 morph 后隐藏
    this.logoMesh.visible = hudRatio < 1 && this._logoHide < 1;
  }

  // 尺寸变化：渲染器 / 合成器 / 各 RT / 相机全部重新对齐
  resize() {
    // 未挂载时忽略
    if (!this.renderer) return;
    // 容器宽
    const w = this.host.clientWidth || window.innerWidth;
    // 容器高
    const h = this.host.clientHeight || window.innerHeight;
    // 重新设置像素比（可能跨屏拖动导致变化）
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // 重设画布尺寸
    this.renderer.setSize(w, h);
    // 合成器内部 RT 同步（会按 pixelRatio 放大）
    this.composer?.setSize(w, h);
    // 雾缓存 RT 跟随物理像素
    this.fogCacheRT?.setSize(this.renderer.domElement.width, this.renderer.domElement.height);
    // bloom 内部 RT 跟随合成器
    this.bloom?.setSize(this.composer.renderTarget1.width, this.composer.renderTarget1.height);
    // 相机宽高比
    if (this.camera) {
      // 用 CSS 宽高（与 W/H 一致）
      this.camera.aspect = w / Math.max(1, h);
      // 重算投影
      this.camera.updateProjectionMatrix();
    }
  }

  // 销毁：停循环、解绑事件、释放所有 GPU 资源
  dispose() {
    // 标记已销毁（RAF 回调据此退出）
    this._disposed = true;
    // 取消待执行的 RAF
    cancelAnimationFrame(this._raf);
    // 解绑滚动
    window.removeEventListener('scroll', this._onScroll);
    // 解绑 resize
    window.removeEventListener('resize', this._onResize);
    // 解绑指针移动
    window.removeEventListener('pointermove', this._onPointerMove);
    // 解绑按下
    window.removeEventListener('pointerdown', this._onPointerDown);
    // 解绑抬起
    window.removeEventListener('pointerup', this._onPointerUp);
    // 解绑取消
    window.removeEventListener('pointercancel', this._onPointerUp);
    // 遍历主场景释放几何与材质
    this.scene?.traverse((o) => {
      // 几何（可能不存在）
      o.geometry?.dispose?.();
      // 材质可能是数组
      if (o.material) {
        // 统一成数组
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        // 逐个释放
        mats.forEach((m) => m.dispose?.());
      }
    });
    // 合成器（含内部 RT）
    this.composer?.dispose?.();
    // 补上的三个后期 pass（composer.dispose 不会释放 pass 自身）
    this.finalPass?.dispose?.();
    this.smaaPass?.dispose?.();
    this.fsrPass?.dispose?.();
    // 粒子系统（sim / 光照场 / LOD）
    this.particles?.dispose();
    // HUD（线条 / 字母 RT）
    this.hud?.dispose();
    // 人脸层（当前未使用，兜底）
    this.faces?.dispose();
    // 标题几何
    this.logoMesh?.geometry.dispose();
    // 标题材质
    this.logoMesh?.material.dispose();
    // 三个预通道材质
    this.preBaseMat?.dispose();
    // 运动模糊预通道材质
    this.preMotionMat?.dispose();
    // HUD 径向模糊材质
    this.preHudBlurMat?.dispose();
    // 雾缓存 RT
    this.fogCacheRT?.dispose();
    // 速度图 RT
    this.motionRT?.dispose();
    // 速度模糊中转 RT
    this.motionTmpRT?.dispose();
    // 9-tap 模糊材质
    this.blurMat?.dispose();
    // 全屏 quad 几何
    this._fsQuad?.geometry.dispose();
    // 拷贝材质
    this._copyMaterial?.dispose();
    // 拷贝 quad 几何
    this._copyQuad?.geometry.dispose();
    // WebGL 上下文
    this.renderer?.dispose();
    // 移除 canvas
    this.renderer?.domElement?.remove();
  }
}
