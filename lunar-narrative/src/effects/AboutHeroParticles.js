/**
 * AboutHeroParticles.js — lusion.co/about 粒子星云 + 体积光照场
 *
 * 逆向依据（bundle）：
 *   AboutHeroParticlesSimulation  @954539  fragSim（curl noise 粒子模拟）
 *   AboutHeroLightField           @947164  64³ 体素切成 512×512 图集 + 时间混合
 *   AboutHeroParticles            @966600  球体 LOD 实例化 + 光照场采样
 *
 * 每帧顺序（原站 AboutHero.update）：
 *   sim.update → lightField.update（清空 drawn 图集）→ particles.update（把粒子点渲染进图集）
 *   → lightField.postUpdate（跨 slice 模糊 + 时间累积）
 */

import * as THREE from 'three';
import { loadBuf } from '../core/BufLoader.js';

// 钳制到 0..1（等价 GLSL 的 saturate）
const saturate = (v) => Math.min(1, Math.max(0, v));
// 线性区间映射：x∈[a,b] → [c,d]，a===b 时直接返回 c（防除零）
const fit = (x, a, b, c, d) => (a === b ? c : c + (d - c) * saturate((x - a) / (b - a)));
// 与 GLSL 同形式的 smoothstep：先归一化，再用 3t²-2t³ 做平滑过渡
const smoothstep = (a, b, x) => {
  // 归一化并钳制
  const t = saturate((x - a) / (b - a));
  // 三次 Hermite 曲线（两端导数为 0）
  return t * t * (3 - 2 * t);
};

// 全屏三角/面片顶点：直接把 position 当裁剪空间坐标，透传 uv 给片元做采样
const FULLSCREEN_VERT = /* glsl */ `
varying vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/* 粒子模拟片元着色器（逆向自 AboutHeroParticlesSimulation 的 fragSim），
 * 每帧对 128×192 的浮点状态图做一次「无状态更新」（GPGPU ping-pong）：
 *   data = (position.xyz, life)
 *   1) life -= (0.5 + noiseStableFactor) * dt —— 生命衰减，噪波稳定因子越大衰减越快
 *   2) life < 0 → 回到默认分布（球壳 * (1.25 + sin 呼吸) + 光源位置），life += 1
 *   3) 绕「随时间旋转的轴」做切向自旋：spinDir = axis × toLight，
 *      强度按到光源距离 smoothstep 增强，并用 v_uv.y < .5 分成正/反两个方向
 *   4) 叠加 curl noise（两次八度 simplex 导数域求旋度）→ 湍流位移
 * 输出直接写回状态纹理，位置与生命都在 RGBA 里，避免额外 pass。 */
const SIM_FRAG = /* glsl */ `uniform sampler2D u_simPrevPosLifeTexture;uniform sampler2D u_simDefaultPosLifeTexture;uniform float u_introDeltaTime;uniform float u_noiseTime;uniform float u_noiseScale;uniform float u_noiseStableFactor;uniform vec3 u_lightPosition;varying vec2 v_uv;
#define PI2 6.283185307179586
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}float mod289(float x){return x-floor(x*(1.0/289.0))*289.0;}vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}float permute(float x){return mod289(((x*34.0)+1.0)*x);}vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}float taylorInvSqrt(float r){return 1.79284291400159-0.85373472095314*r;}vec4 grad4(float j,vec4 ip){const vec4 ones=vec4(1.0,1.0,1.0,-1.0);vec4 p,s;p.xyz=floor(fract(vec3(j)*ip.xyz)*7.0)*ip.z-1.0;p.w=1.5-dot(abs(p.xyz),ones.xyz);s=vec4(lessThan(p,vec4(0.0)));p.xyz=p.xyz+(s.xyz*2.0-1.0)*s.www;return p;}
#define F4 0.309016994374947451
vec4 simplexNoiseDerivatives(vec4 v){const vec4 C=vec4(0.138196601125011,0.276393202250021,0.414589803375032,-0.447213595499958);vec4 i=floor(v+dot(v,vec4(F4)));vec4 x0=v-i+dot(i,C.xxxx);vec4 i0;vec3 isX=step(x0.yzw,x0.xxx);vec3 isYZ=step(x0.zww,x0.yyz);i0.x=isX.x+isX.y+isX.z;i0.yzw=1.0-isX;i0.y+=isYZ.x+isYZ.y;i0.zw+=1.0-isYZ.xy;i0.z+=isYZ.z;i0.w+=1.0-isYZ.z;vec4 i3=clamp(i0,0.0,1.0);vec4 i2=clamp(i0-1.0,0.0,1.0);vec4 i1=clamp(i0-2.0,0.0,1.0);vec4 x1=x0-i1+C.xxxx;vec4 x2=x0-i2+C.yyyy;vec4 x3=x0-i3+C.zzzz;vec4 x4=x0+C.wwww;i=mod289(i);float j0=permute(permute(permute(permute(i.w)+i.z)+i.y)+i.x);vec4 j1=permute(permute(permute(permute(i.w+vec4(i1.w,i2.w,i3.w,1.0))+i.z+vec4(i1.z,i2.z,i3.z,1.0))+i.y+vec4(i1.y,i2.y,i3.y,1.0))+i.x+vec4(i1.x,i2.x,i3.x,1.0));vec4 ip=vec4(1.0/294.0,1.0/49.0,1.0/7.0,0.0);vec4 p0=grad4(j0,ip);vec4 p1=grad4(j1.x,ip);vec4 p2=grad4(j1.y,ip);vec4 p3=grad4(j1.z,ip);vec4 p4=grad4(j1.w,ip);vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;p4*=taylorInvSqrt(dot(p4,p4));vec3 values0=vec3(dot(p0,x0),dot(p1,x1),dot(p2,x2));vec2 values1=vec2(dot(p3,x3),dot(p4,x4));vec3 m0=max(0.5-vec3(dot(x0,x0),dot(x1,x1),dot(x2,x2)),0.0);vec2 m1=max(0.5-vec2(dot(x3,x3),dot(x4,x4)),0.0);vec3 temp0=-6.0*m0*m0*values0;vec2 temp1=-6.0*m1*m1*values1;vec3 mmm0=m0*m0*m0;vec2 mmm1=m1*m1*m1;float dx=temp0[0]*x0.x+temp0[1]*x1.x+temp0[2]*x2.x+temp1[0]*x3.x+temp1[1]*x4.x+mmm0[0]*p0.x+mmm0[1]*p1.x+mmm0[2]*p2.x+mmm1[0]*p3.x+mmm1[1]*p4.x;float dy=temp0[0]*x0.y+temp0[1]*x1.y+temp0[2]*x2.y+temp1[0]*x3.y+temp1[1]*x4.y+mmm0[0]*p0.y+mmm0[1]*p1.y+mmm0[2]*p2.y+mmm1[0]*p3.y+mmm1[1]*p4.y;float dz=temp0[0]*x0.z+temp0[1]*x1.z+temp0[2]*x2.z+temp1[0]*x3.z+temp1[1]*x4.z+mmm0[0]*p0.z+mmm0[1]*p1.z+mmm0[2]*p2.z+mmm1[0]*p3.z+mmm1[1]*p4.z;float dw=temp0[0]*x0.w+temp0[1]*x1.w+temp0[2]*x2.w+temp1[0]*x3.w+temp1[1]*x4.w+mmm0[0]*p0.w+mmm0[1]*p1.w+mmm0[2]*p2.w+mmm1[0]*p3.w+mmm1[1]*p4.w;return vec4(dx,dy,dz,dw)*49.0;}vec3 curl(in vec3 p,in float noiseTime,in float persistence){vec4 xNoisePotentialDerivatives=vec4(0.0);vec4 yNoisePotentialDerivatives=vec4(0.0);vec4 zNoisePotentialDerivatives=vec4(0.0);for(int i=0;i<2;++i){float twoPowI=pow(2.0,float(i));float scale=0.5*twoPowI*pow(persistence,float(i));xNoisePotentialDerivatives+=simplexNoiseDerivatives(vec4(p*twoPowI,noiseTime))*scale;yNoisePotentialDerivatives+=simplexNoiseDerivatives(vec4((p+vec3(123.4,129845.6,-1239.1))*twoPowI,noiseTime))*scale;zNoisePotentialDerivatives+=simplexNoiseDerivatives(vec4((p+vec3(-9519.0,9051.0,-123.0))*twoPowI,noiseTime))*scale;}return vec3(xNoisePotentialDerivatives[3]-zNoisePotentialDerivatives[1],zNoisePotentialDerivatives[2]-yNoisePotentialDerivatives[3],yNoisePotentialDerivatives[1]-xNoisePotentialDerivatives[2]);}void main(){vec4 posLife=texture2D(u_simPrevPosLifeTexture,v_uv);vec3 posLifeOrigin=posLife.xyz-u_lightPosition;posLife.w-=(0.5+u_noiseStableFactor)*u_introDeltaTime;if(posLife.w<0.0){vec3 defPosOrigin=texture2D(u_simDefaultPosLifeTexture,v_uv).xyz;vec3 defPos=defPosOrigin*(1.25+sin(u_noiseTime*2.5+v_uv.x*21.)*0.25)+u_lightPosition;posLife.w+=1.;posLife.xyz=defPos;}vec3 toLight=posLife.xyz-u_lightPosition;vec3 axis=vec3(sin(u_noiseTime),cos(u_noiseTime*2.+v_uv.y*6.283185),0.0);vec3 spinDir=cross(axis,toLight);float dist=length(toLight);if(dist>0.01){float spinStrength=u_introDeltaTime*(0.1+smoothstep(0.5,2.0,dist-v_uv.x*0.5)*(v_uv.y<0.5 ? 1. :-1.)*mix(2.,4.,v_uv.x))*mix(0.75,1.5,u_noiseStableFactor);posLife.xyz+=spinDir*spinStrength;}posLife.xyz+=(1.25+0.5*u_noiseScale)*curl((posLife.xyz-u_lightPosition)*(0.4+0.3*u_noiseStableFactor),u_noiseTime,0.2)*u_introDeltaTime*mix(0.4,1.5,posLife.w*posLife.w)*mix(0.75,1.25,v_uv.x);gl_FragColor=posLife;}`;
/* 粒子顶点着色器（逆向自 AboutHeroParticles 的 vert）：
 * 每个实例从 sim 状态图读出位置，再用球体 LOD（sphere_l/m/s/xs）当点精灵。
 *   particleSize = mix(.06,.175,u_isEmissive) * (.5 + rand) —— 发光粒子更大
 *   particleSizeScale —— 生命两端（0 与 1）收缩到 0，避免重置瞬间突变
 *   u_sceneHideRatio —— HUD 阶段整体缩小退场
 * 光照不是直接打灯，而是把世界位置 + 法线转成「光照场网格坐标」后
 * 采样 64³ 体积光照图（sampleLightField），得到间接漫反射 a 通道作为 AO/能量。
 * v_emission / v_diff / v_ao 三个量交给片元做最终调色。 */
const PARTICLE_VERT = /* glsl */ `attribute vec3 simUv;uniform sampler2D u_simCurrPosLifeTexture;uniform vec2 u_simTextureSize;uniform float u_sceneHideRatio;uniform float u_isEmissive;uniform float u_noiseStableFactor;uniform sampler2D u_lightFieldSlicedTexture;
#include <lightFieldSlice>
varying vec3 v_worldPosition;varying vec3 v_viewNormal;varying vec3 v_worldNormal;varying float v_depth;varying float v_diff;varying float v_ao;varying float v_emission;float linearStep(float edge0,float edge1,float x){return clamp((x-edge0)/(edge1-edge0),0.0,1.0);}vec4 hash43(vec3 p){vec4 p4=fract(vec4(p.xyzx)*vec4(.1031,.1030,.0973,.1099));p4+=dot(p4,p4.wzxy+33.33);return fract((p4.xxyz+p4.yzzw)*p4.zywx);}void main(){vec4 currPositionInfo=texture2D(u_simCurrPosLifeTexture,simUv.xy);vec4 rands=hash43(simUv);float particleSize=mix(0.06,0.175,u_isEmissive)*(0.5+rands.x*0.5);float particleSizeScale=linearStep(0.0,0.1,currPositionInfo.w)*linearStep(1.0,0.9,currPositionInfo.w);particleSize*=particleSizeScale*(1.0-u_sceneHideRatio);vec3 pos=position*particleSize+currPositionInfo.xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(pos,1.0);v_worldPosition=(modelMatrix*vec4(pos,1.0)).xyz;v_viewNormal=normalMatrix*normal;v_worldNormal=normalize((vec4(v_viewNormal,0.)*viewMatrix).xyz);vec3 rayGridDir=v_worldNormal;vec3 rayGridPos=lightFieldPosToGrid(v_worldPosition);vec4 indirectDiffuse=sampleLightField(u_lightFieldSlicedTexture,rayGridPos+rayGridDir);float lifeFalloff=mix(0.5,1.,particleSizeScale);v_emission=(indirectDiffuse.a*0.55*lifeFalloff+0.45)*u_isEmissive;v_diff=(1.-indirectDiffuse.a)*lifeFalloff;v_diff*=linearStep(5.,1.5,length(v_worldPosition-vec3(0.,8.,0.)));v_ao=1.0-indirectDiffuse.a;
#include <aboutHeroVisualFinal_vert>
}`;
/* 粒子片元着色器（逆向自 AboutHeroParticles 的 frag）：
 * 三次采样同一张光照场，靠方向扰动得到「散射 / 高光 / 折射」三种间接光：
 *   specular   —— 反射方向 + 蓝噪声抖动
 *   refraction —— refract(视线, 法线, 1/1.4) 折射方向 + 抖动（假次表面/玻璃感）
 *   getScatter —— 胶囊光源线积分（光柱），这里乘 1.35 作为体积雾感
 * 输出打包成 (亮度, 深度, 1, 透光权重)，后续 efx 预通道只取 r、用 a 做泛光遮罩。 */
const PARTICLE_FRAG = /* glsl */ `uniform sampler2D u_lightFieldSlicedTexture;uniform float u_noiseStableFactor;uniform float u_emissiveRatio;uniform float u_contrast;varying vec3 v_worldPosition;varying vec3 v_worldNormal;varying vec3 v_viewNormal;varying float v_depth;varying float v_diff;varying float v_emission;varying float v_ao;
#include <lightFieldSlice>
#include <getScatter>
#include <getBlueNoise>
float linearStep(float edge0,float edge1,float x){return clamp((x-edge0)/(edge1-edge0),0.0,1.0);}void main(){vec3 noise=getBlueNoise(gl_FragCoord.xy);vec3 viewNormal=normalize(v_viewNormal);vec3 worldNormal=normalize(v_worldNormal);vec3 rayGridPos=lightFieldPosToGrid(v_worldPosition);vec3 rayGridDir=worldNormal;vec3 rayGridSpecDir=reflect(normalize(v_worldPosition-cameraPosition),worldNormal);vec4 indirectSpecular=sampleLightField(u_lightFieldSlicedTexture,rayGridPos+normalize(rayGridSpecDir+(noise-.5)*0.25)*(1.+noise.z));float specular=indirectSpecular.r;vec3 rayGridRefractDir=refract(normalize(v_worldPosition-cameraPosition),worldNormal,1./1.4);vec4 refractionInfo=sampleLightField(u_lightFieldSlicedTexture,rayGridPos+normalize(rayGridRefractDir+(noise-.5)*0.25)*(1.5+noise.z));float refraction=refractionInfo.r*(1.-refractionInfo.a*0.75);float shade=v_diff*0.45+specular+refraction;shade+=getScatter(cameraPosition,v_worldPosition)*1.35;float viewShade=linearStep(-1.,1.,dot(viewNormal,vec3(.5773)));shade=mix(shade,viewShade,v_emission*v_ao)*(.4+v_ao*.6);gl_FragColor=vec4(mix(shade,smoothstep(0.,1.,shade),0.5),v_depth,1.,mix(v_diff*v_diff+v_emission,1.,u_emissiveRatio));}`;
/* 光照场「写入」顶点着色器（逆向自 AboutHeroLightField 的 draw vert）：
 * 复用粒子网格的 simUv 作为位置，把每个粒子投影到光照场的图集 uv 上，
 * 点大小固定 1px，用 Max 混合把「有没有光」写进对应体素。
 *   position.x < 0.005 的那一条（第 0 列）写 1.0，其余写 0.1，
 *   相当于原站用额外一列标记「光源自身」的体素。 */
const LF_VERT = /* glsl */ `uniform sampler2D u_simCurrPosLifeTexture;uniform float u_noiseStableFactor;
#include <lightFieldSlice>
varying vec4 v_color;float linearStep(float edge0,float edge1,float x){return clamp((x-edge0)/(edge1-edge0),0.0,1.0);}vec4 hash43(vec3 p){vec4 p4=fract(vec4(p.xyzx)*vec4(.1031,.1030,.0973,.1099));p4+=dot(p4,p4.wzxy+33.33);return fract((p4.xxyz+p4.yzzw)*p4.zywx);}void main(){vec4 rands=hash43(position);vec4 currPositionInfo=texture2D(u_simCurrPosLifeTexture,position.xy);float scale=linearStep(1.0,0.9,currPositionInfo.w);vec3 pos=currPositionInfo.xyz;vec3 lightFieldGrid=clampedLightFieldPosToGrid(pos);vec2 lightFieldUv=lightFieldGridToUv(lightFieldGrid);gl_Position=vec4(lightFieldUv*2.0-1.0,0.0,1.0);gl_PointSize=1.0;vec3 color=position.x<0.005 ? vec3(1.): vec3(0.1);v_color=vec4(color,1.)*scale;}`;
const LF_FRAG = /* glsl */ `varying vec4 v_color;void main(){gl_FragColor=v_color;}`;
/* 光照场切片工具（原站 chunk: lightFieldSlice）：
 * 64³ 体积按 z 切片，每片 64×64 拼成 8 列 × 8 行 = 512×512 图集。
 *   lightFieldGridToUv      —— 体素网格 (x,y,z) → 图集 uv（含 colRow 偏移）
 *   lightFieldGridToUv3     —— 归一化网格坐标（未使用，保留语义）
 *   clampLightFieldGrid     —— 钳到体素中心，避免采样出界
 *   lightFieldPosToGrid     —— 世界位置 → 网格坐标（体积偏移/尺寸 → 体素数）
 *   sampleLightField        —— 沿 z 在相邻两片间线性插值（三线性采样的近似）
 * 所有用到光照场的着色器都通过 #include <lightFieldSlice> 共享这份实现。 */
export const LF_SLICE = /* glsl */ `uniform vec2 u_lightFieldSlicedTextureSize;uniform vec2 u_lightFieldSliceColRowCount;uniform vec3 u_lightFieldGridCount;uniform vec3 u_lightFieldVolumeOffset;uniform vec3 u_lightFieldVolumeSize;vec2 lightFieldGridToUv(vec3 grid){vec2 uv=grid.xy;vec2 colRow=floor(vec2(mod(grid.z,u_lightFieldSliceColRowCount.x),grid.z/u_lightFieldSliceColRowCount.x));uv+=colRow*u_lightFieldGridCount.xy+.5;return uv/u_lightFieldSlicedTextureSize;}vec3 lightFieldGridToUv3(vec3 grid){return grid/u_lightFieldGridCount;}vec3 clampLightFieldGrid(vec3 grid){return clamp(grid,vec3(.5),u_lightFieldGridCount-vec3(.5));}vec3 lightFieldPosToGrid(vec3 pos){return(pos-u_lightFieldVolumeOffset)/u_lightFieldVolumeSize*u_lightFieldGridCount;}vec3 clampedLightFieldPosToGrid(vec3 pos){return clampLightFieldGrid(lightFieldPosToGrid(pos));}vec4 sampleLightField(sampler2D tex,vec3 gridPos){gridPos.z-=.5;vec2 uv1=lightFieldGridToUv(clampLightFieldGrid(vec3(gridPos.xy,floor(gridPos.z)+.5)));vec2 uv2=lightFieldGridToUv(clampLightFieldGrid(vec3(gridPos.xy,ceil(gridPos.z)+.5)));return mix(texture2D(tex,uv1),texture2D(tex,uv2),fract(gridPos.z));}`;
/* 光照场时间累积（原站 lightField.postUpdate）：
 * 对每片体素做 z 方向的 3 邻域加权（-1 / 0 / +1，权重 .25/.5/.25），
 * 再把结果按 mix(0.15, 0.08, prev.r) 向上一帧收敛：
 * 亮处收敛快、暗处收敛慢 —— 形成「光照余晖/延迟」效果，也是光柱柔和的关键。 */
const LF_BLEND_FRAG = /* glsl */ `uniform sampler2D u_prevSliceTexture;uniform sampler2D u_drawnSliceTexture;varying vec2 v_uv;
#include <lightFieldSlice>
vec4 sampleSlice4(vec3 gridPos){vec3 sliceOffset=vec3(-.5,.5,0.);return(texture2D(u_drawnSliceTexture,lightFieldGridToUv(clampLightFieldGrid(gridPos+sliceOffset.xxz)))+texture2D(u_drawnSliceTexture,lightFieldGridToUv(clampLightFieldGrid(gridPos+sliceOffset.xyz)))+texture2D(u_drawnSliceTexture,lightFieldGridToUv(clampLightFieldGrid(gridPos+sliceOffset.yxz)))+texture2D(u_drawnSliceTexture,lightFieldGridToUv(clampLightFieldGrid(gridPos+sliceOffset.yyz))))/4.;}void main(){vec3 gridPos=vec3(mod(gl_FragCoord.xy,u_lightFieldGridCount.xy),dot(floor(gl_FragCoord.xy/u_lightFieldGridCount.xy),vec2(1.,u_lightFieldSliceColRowCount.x))+.5);vec4 prev=texture2D(u_prevSliceTexture,v_uv);vec4 curr=(sampleSlice4(gridPos+vec3(0.,0.,-1.))+sampleSlice4(gridPos)*2.+sampleSlice4(gridPos+vec3(0.,0.,1.)))*.25;prev+=(curr-prev)*mix(0.15,0.08,clamp(prev.r,0.,1.));gl_FragColor=prev;}`;

/* 运动模糊顶点着色器（逆向自原站 motionMesh）：
 * 把每个粒子的当前/上一帧位置投影到屏幕，得到 2D 速度向量 v_delta；
 * 用 quad 的两端（position.x 正负）分别锚在 curr / prev 屏幕位置，
 * 再按速度方向旋转拉长 → 一颗「拉丝」的拖尾面片。
 * 生命刚重置（curr.life > prev.life）时把顶点踢出裁剪空间（gl_Position=(2,0,0,1)），
 * 避免重置瞬间拉出一条穿屏的长条。 */
const MOTION_VERT = /* glsl */ `attribute vec2 simUv;uniform sampler2D u_simPrevPosLifeTexture;uniform sampler2D u_simCurrPosLifeTexture;uniform vec2 u_simTextureSize;uniform float u_strength;uniform float u_aspect;varying vec2 v_delta;varying float v_headTail;float linearStep(float edge0,float edge1,float x){return clamp((x-edge0)/(edge1-edge0),0.0,1.0);}vec4 hash43(vec3 p){vec4 p4=fract(vec4(p.xyzx)*vec4(.1031,.1030,.0973,.1099));p4+=dot(p4,p4.wzxy+33.33);return fract((p4.xxyz+p4.yzzw)*p4.zywx);}vec2 rotate(vec2 v,float a){float s=sin(a);float c=cos(a);mat2 m=mat2(c,s,-s,c);return m*v;}void main(){vec4 currPositionInfo=texture2D(u_simCurrPosLifeTexture,simUv);vec4 prevPositionInfo=texture2D(u_simPrevPosLifeTexture,simUv);vec4 rands=hash43(vec3(simUv.xy,0.));float particleSize=(simUv.x<0.005 ? 0.175 : 0.06)*(0.5+rands.x*0.5);mat4 mvp=projectionMatrix*modelViewMatrix;vec4 currScreenPos=mvp*vec4(currPositionInfo.xyz,1.0);vec4 prevScreenPos=mvp*vec4(prevPositionInfo.xyz,1.0);currScreenPos/=currScreenPos.w;prevScreenPos/=prevScreenPos.w;vec2 screenPosDelta=currScreenPos.xy-prevScreenPos.xy;float screenPosDist=length(screenPosDelta);float angle=screenPosDist>0.001 ? atan(screenPosDelta.y,screenPosDelta.x*u_aspect): 0.;vec4 screenPos=position.x>-0.0001 ? currScreenPos : prevScreenPos;vec4 offsetScreenPos=modelViewMatrix*vec4((position.x>0. ? currPositionInfo.xyz : prevPositionInfo.xyz),1.0);offsetScreenPos.xy+=particleSize;offsetScreenPos=projectionMatrix*offsetScreenPos;offsetScreenPos/=offsetScreenPos.w;offsetScreenPos=offsetScreenPos-screenPos;v_delta=screenPosDelta;v_headTail=position.x;vec4 pos=vec4(position,0.);pos.xy=rotate(pos.xy,angle)*length(offsetScreenPos.xy*vec2(u_aspect,1.));pos.xy*=vec2(1./u_aspect,1.);pos+=screenPos;pos.xy+=v_delta*.5;v_delta=v_delta*2.+.5;gl_Position=pos;if(currPositionInfo.w>prevPositionInfo.w){gl_Position=vec4(2.,0.,0.,1.);}}`;
/* 运动模糊片元着色器：仅把顶点传来的 v_delta / v_headTail 编码成纹理，
 * xy = 屏幕空间速度方向（0..1 编码），z = 强度，a = 头尾权重。 */
const MOTION_FRAG = /* glsl */ `varying vec2 v_delta;varying float v_headTail;void main(){float ratio=sqrt(abs(v_headTail)*2.);float strength=sign(v_headTail)*ratio*-.5;gl_FragColor=vec4(v_delta,strength+.5,v_headTail+0.5);}`;

/* 原站 Simple1DNoise：给 u_noiseScale / u_noiseStableFactor 提供平滑随机 */
// 一维值噪声：查表 + 平滑插值，用来驱动「噪波强度」和「稳定性」这两个标量
class Simple1DNoise {
  constructor() {
    // 噪声表长度（必须是 2 的幂，便于用位掩码取模）
    this.MAX_VERTICES = 512;
    // 取模掩码：511 = 512 - 1，等价 x % 512（且要求 x 非负）
    this.MASK = 511;
    // 采样缩放（>1 时噪声变化更快）
    this._scale = 1;
    // 输出幅度（>1 放大）
    this._amplitude = 1;
    // 随机数表：-0.5..0.5，作为各整数格点的值
    this._r = [];
    // 预生成 512 个随机格点值（表只会被读取，不随采样改变）
    for (let i = 0; i < 512; i++) this._r.push(Math.random() - 0.5);
  }
  // 取 x 处的噪声值：找到相邻两个格点，按 smoothstep 权重插值
  getVal(x) {
    // 缩放到噪声空间
    const t = x * this._scale;
    // 左格点整数索引
    const r = Math.floor(t);
    // 格内小数部分
    const n = t - r;
    // 平滑权重（3t²-2t³，保证一阶连续）
    const a = n * n * (3 - 2 * n);
    // 用位掩码把索引折回表长以内
    const i = r & this.MASK;
    // 右邻格点（同样回绕）
    const j = (i + 1) & this.MASK;
    // 在左右格点之间插值，并乘上幅度
    return (this._r[i] + (this._r[j] - this._r[i]) * a) * this._amplitude;
  }
  // 分形叠加（fBm）：多倍频叠加，振幅每层减半 → 更自然的起伏
  getFbm(x, octaves) {
    // 累加值
    let sum = 0;
    // 初始振幅 0.5
    let amp = 0.5;
    // 逐层叠加
    for (let i = 0; i < octaves; i++) {
      // 加入本层贡献
      sum += amp * this.getVal(x);
      // 频率翻倍
      x *= 2;
      // 振幅减半
      amp *= 0.5;
    }
    // 返回叠加结果
    return sum;
  }
}

// 粒子星云：sim（GPGPU）+ 光照场（体积图集）+ 球体 LOD 实例化 + 屏幕空间拖尾
export class AboutHeroParticles {
  constructor({ renderer, scene, shared, withChunks }) {
    // 渲染器：所有 RT 的 pass 都直接调用它
    this.renderer = renderer;
    // 主场景：粒子网格最后会被 add 进去
    this.scene = scene;
    // 全局共享 uniform（时间 / 场景比例 / 光源位置等）
    this.shared = shared;
    // chunk 注入函数（#include <lightFieldSlice> 等）
    this.chunk = withChunks;

    // 模拟状态图宽度：128（与 64³ 光照场同量级的粒子数）
    this.SIM_W = 128;
    // 模拟状态图高度：192 → 共 24576 个粒子
    this.SIM_H = 192;
    // 光照场体素数：64×64×64（原站同规格）
    this.GRID_COUNT = new THREE.Vector3(64, 64, 64);
    // 光照场覆盖的世界体积：8×8×8
    this.VOLUME_SIZE = new THREE.Vector3(8, 8, 8);
    // 单个体素对应的世界尺寸（用于体积偏移修正）
    this.gridSize = this.VOLUME_SIZE.x / (this.GRID_COUNT.x - 1);

    // 粒子容器：整体显隐/位移都走这里
    this.container = new THREE.Group();
    // 一维噪声发生器（驱动噪波强度与稳定性）
    this._noise = new Simple1DNoise();
    // u_noiseScale 的时间轴起点（随机，避免每次打开都同一相位）
    this._noiseScaleTime = Math.random();
    // u_noiseStableFactor 的时间轴起点
    this._nsfTime = Math.random();
    // u_noiseStableFactor 的累积值（每帧累加正向噪声，形成缓慢攀升）
    this._nsf = Math.random();

    // 用于全屏 pass 的正交相机占位（着色器不用相机矩阵，传什么都行）
    this._camera = new THREE.Camera();
    // 全屏 pass 专用场景
    this._quadScene = new THREE.Scene();
    // 全屏 quad（2×2 面片）
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    // 关闭视锥剔除
    this._quad.frustumCulled = false;
    // 入场景
    this._quadScene.add(this._quad);
  }

  // 一次性构建：sim 双缓冲 → 光照场三缓冲 → 光照场写入点集 → 拖尾 → 粒子网格
  async load() {
    // 状态图宽（粒子列数）
    const W = this.SIM_W;
    // 状态图高
    const H = this.SIM_H;
    // 粒子总数
    const count = W * H;
    // 渲染器简写
    const r = this.renderer;

    /* ── sim：128×192 Float 双缓冲 ── */
    // RT 参数：浮点精度（位置可超 1）、最近邻（逐像素精确对应）、不建深度/模板
    const simOpts = {
      // 半精度不够，位置需要完整 float32
      type: THREE.FloatType,
      // 采样时不做插值，保证每个粒子读到自己的状态
      minFilter: THREE.NearestFilter,
      // 同上
      magFilter: THREE.NearestFilter,
      // 无深度
      depthBuffer: false,
      // 无模板
      stencilBuffer: false,
    };
    // 两张 RT 组成 ping-pong：一张读、一张写，每帧交换
    this.simRT = [new THREE.WebGLRenderTarget(W, H, simOpts), new THREE.WebGLRenderTarget(W, H, simOpts)];
    // 当前（本帧要写入 / 上一帧已写入）的状态
    this.simCurr = this.simRT[0];
    // 上一帧状态（作为 shader 输入）
    this.simPrev = this.simRT[1];

    // 默认状态图：每个粒子初始位置 + 生命值
    const data = new Float32Array(count * 4);
    // 逐粒子生成球壳上的随机点
    for (let n = 0, a = 0; n < count; n++, a += 4) {
      // 方位角 u ∈ [0, 2π)
      const u = Math.random() * 2 * Math.PI;
      // 极角 v ∈ [0, π]（acos 保证球面均匀）
      const v = Math.acos(2 * Math.random() - 1);
      // 半径：0.25 + cbrt(rand)*0.5，cbrt 让体积内分布均匀（偏外壳）
      const p = 0.25 + Math.cbrt(Math.random()) * 0.5;
      // sin(v) 复用两次
      const sinV = Math.sin(v);
      // x = r·sinθ·cosφ
      data[a + 0] = p * sinV * Math.cos(u);
      // y = r·sinθ·sinφ
      data[a + 1] = p * sinV * Math.sin(u);
      // z = r·cosθ
      data[a + 2] = p * Math.cos(v);
      // 生命值：n/count - 1 → 均匀分布在 (-1, 0]，
      // 配合 sim 里 life<0 立即重生，初次就能看到错峰出现的粒子流
      data[a + 3] = n / count - 1;
    }
    // 默认状态纹理（DataTexture 直接当 sim 的「重生目标」）
    const defaultTex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    // 最近邻采样，保证像素与粒子一一对应
    defaultTex.minFilter = defaultTex.magFilter = THREE.NearestFilter;
    // 上传
    defaultTex.needsUpdate = true;

    // sim 的 uniform 表：全局 shared + 状态纹理 + 时间/噪声参数
    this.simUniforms = {
      // 展开全局共享（u_lightPosition / u_noiseStableFactor 等）
      ...this.shared,
      // 当前状态纹理（每帧交换后重指）
      u_simCurrPosLifeTexture: { value: null },
      // 上一帧状态纹理
      u_simPrevPosLifeTexture: { value: null },
      // 默认/重生分布纹理
      u_simDefaultPosLifeTexture: { value: defaultTex },
      // 状态图尺寸（预留，便于 shader 做像素级运算）
      u_simTextureSize: { value: new THREE.Vector2(W, H) },
      // 本帧 dt（子弹时间时会被减速）
      u_introDeltaTime: { value: 0 },
      // 噪声时间（推进 curl noise 场）
      u_noiseTime: { value: 0 },
      // 噪声强度（由一维 fBm 驱动湍流幅度）
      u_noiseScale: { value: 0 },
    };
    // sim 材质：全屏 fs 跑一次 = 全体粒子前进一帧
    this.simMaterial = new THREE.ShaderMaterial({
      // 上面这张 uniform 表
      uniforms: this.simUniforms,
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // sim 片元（需 chunk 注入 simplex / curl）
      fragmentShader: this.chunk(SIM_FRAG),
      // 不需要深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });

    // 初始位置写进两个 RT
    // 拷贝材质：把默认状态图原样复制到 RT（初始化 ping-pong 两张）
    this.copyMaterial = new THREE.ShaderMaterial({
      // 输入就是默认状态图
      uniforms: { u_texture: { value: defaultTex } },
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // 直接采样输出
      fragmentShader: 'varying vec2 v_uv; uniform sampler2D u_texture; void main(){ gl_FragColor = texture2D(u_texture, v_uv); }',
      // 无深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });
    // 初始化 simRT[0]
    this._renderQuad(this.copyMaterial, this.simRT[0]);
    // 初始化 simRT[1]（两张状态一致，保证第一帧 prev 有效）
    this._renderQuad(this.copyMaterial, this.simRT[1]);
    // 回到屏幕目标，避免影响后续渲染
    this.renderer.setRenderTarget(null);
    // 绑定当前状态纹理
    this.simUniforms.u_simCurrPosLifeTexture.value = this.simCurr.texture;
    // 绑定上一帧状态纹理
    this.simUniforms.u_simPrevPosLifeTexture.value = this.simPrev.texture;

    /* ── 光照场：64³ 体素 → 8×8 张 512×512 图集 ── */
    // 体素总数 = 64³ = 262144
    const cellCount = this.GRID_COUNT.x * this.GRID_COUNT.y * this.GRID_COUNT.z;
    // 图集列数：sqrt(总数)/每片宽 → 8（即每行放 8 片）
    const cols = Math.ceil(Math.sqrt(cellCount) / this.GRID_COUNT.x);
    // 图集行数：z 切片数 / 列数 → 8
    const rows = Math.ceil(this.GRID_COUNT.z / cols);
    // 记录列数（给 shader 的 u_lightFieldSliceColRowCount）
    this.lfCols = cols;
    // 记录行数
    this.lfRows = rows;
    // 图集边长 = 每片宽 × 列数 = 64×8 = 512
    this.lfSize = this.GRID_COUNT.x * cols;
    // RT 参数：8 位足够（只存「有没有光」的软性权重），线性过滤便于跨体素平滑
    const lfOpts = {
      // 用 UnsignedByte 省显存（原站同样用低精度累积）
      type: THREE.UnsignedByteType,
      // 线性放大
      minFilter: THREE.LinearFilter,
      // 线性缩小
      magFilter: THREE.LinearFilter,
      // 无深度
      depthBuffer: false,
      // 无模板
      stencilBuffer: false,
    };
    // 三缓冲：curr（本帧结果）/ prev（上帧，做时间累积）/ drawn（本帧粒子点，待模糊）
    this.lfRT = [new THREE.WebGLRenderTarget(this.lfSize, this.lfSize, lfOpts), new THREE.WebGLRenderTarget(this.lfSize, this.lfSize, lfOpts), new THREE.WebGLRenderTarget(this.lfSize, this.lfSize, lfOpts)];
    // 当前光照场
    this.lfCurr = this.lfRT[0];
    // 上一帧光照场
    this.lfPrev = this.lfRT[1];
    // 本帧刚画进去的粒子点（未模糊）
    this.lfDrawn = this.lfRT[2];

    // 光照场专用 uniform：图集尺寸 / 列行数 / 体素网格 / 体积偏移与尺寸
    this.lfUniforms = {
      // 采样用的图集纹理（curr）
      u_lightFieldSlicedTexture: { value: this.lfCurr.texture },
      // 图集像素尺寸
      u_lightFieldSlicedTextureSize: { value: new THREE.Vector2(this.lfSize, this.lfSize) },
      // 每个切片在 z 方向排布成 cols × rows
      u_lightFieldSliceColRowCount: { value: new THREE.Vector2(cols, rows) },
      // 体素分辨率（64,64,64）
      u_lightFieldGridCount: { value: this.GRID_COUNT },
      // 体积左下角的世界偏移（每帧按光源位置重算）
      u_lightFieldVolumeOffset: { value: new THREE.Vector3() },
      // 体积世界尺寸：多一个体素，保证边界体素中心也能采到
      u_lightFieldVolumeSize: { value: new THREE.Vector3().setScalar(this.gridSize).add(this.VOLUME_SIZE) },
    };

    // 时间累积材质：上一帧 + 本帧 drawn 做模糊与混合
    this.lfBlendMaterial = new THREE.ShaderMaterial({
      // 光照场 uniform + 两张输入切片
      uniforms: {
        // 展开光照场公共 uniform
        ...this.lfUniforms,
        // 上一帧结果
        u_prevSliceTexture: { value: null },
        // 本帧绘制的粒子点
        u_drawnSliceTexture: { value: this.lfDrawn.texture },
      },
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // 混合片元（需 chunk：切片工具函数）
      fragmentShader: this.chunk(LF_BLEND_FRAG),
      // 无深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });

    /* 把每个粒子的 sim uv 映射到图集像素：Points，Max 混合 */
    // 点集位置：直接用 sim 状态图的像素中心 uv（shader 里读状态并算网格坐标）
    const lfPos = new Float32Array(count * 3);
    // 逐粒子填 uv（z 保持 0，实际未使用）
    for (let p = 0, g = 0; p < count; p++, g += 3) {
      // u = 列号中心 / 列数
      lfPos[g + 0] = (p % W + 0.5) / W;
      // v = 行号中心 / 行数
      lfPos[g + 1] = (Math.floor(p / W) + 0.5) / H;
    }
    // 光照场写入用的几何
    const lfGeo = new THREE.BufferGeometry();
    // 位置属性 = 上面的 uv 列表
    lfGeo.setAttribute('position', new THREE.BufferAttribute(lfPos, 3));
    // 点集：每个粒子一个 1px 点，写进图集
    this.lfMesh = new THREE.Points(
      // 几何
      lfGeo,
      // 材质：sim uniform（读状态）+ 光照场 uniform（写图集）
      new THREE.ShaderMaterial({
        // 两套 uniform 合并
        uniforms: { ...this.simUniforms, ...this.lfUniforms },
        // 写入顶点（需 chunk：切片工具）
        vertexShader: this.chunk(LF_VERT),
        // 片元只是透传颜色
        fragmentShader: LF_FRAG,
        // 自定义混合
        blending: THREE.CustomBlending,
        // 颜色取最大：多个粒子落在同一体素时保留最亮
        blendEquation: THREE.MaxEquation,
        // 源因子 1
        blendSrc: THREE.OneFactor,
        // 目标因子 1
        blendDst: THREE.OneFactor,
        // alpha 也取最大
        blendEquationAlpha: THREE.MaxEquation,
        // alpha 源 1
        blendSrcAlpha: THREE.OneFactor,
        // alpha 目标 1
        blendDstAlpha: THREE.OneFactor,
        // 无深度
        depthTest: false,
        // 不写深度
        depthWrite: false,
      })
    );
    // 顶点位置由 shader 直接写裁剪空间，不做剔除
    this.lfMesh.frustumCulled = false;
    // 光照场绘制专用场景
    this.lfScene = new THREE.Scene();
    // 点集入场景
    this.lfScene.add(this.lfMesh);

    /* ── 运动模糊 quad（原站 motionMesh：screen-space 拖尾） ── */
    // 单位面片：顶点 x 取 -0.5..0.5，正好表示「上一帧 → 当前帧」的拉丝
    const motionPlane = new THREE.PlaneGeometry(1, 1);
    // 实例化几何：每个粒子一个面片
    const motionGeo = new THREE.InstancedBufferGeometry();
    // 面片基础属性
    for (const [k, v] of Object.entries(motionPlane.attributes)) motionGeo.setAttribute(k, v);
    // 索引
    motionGeo.setIndex(motionPlane.index);
    // 复用 sim 的 uv 当实例属性（直接定位到该粒子的状态）
    motionGeo.setAttribute('simUv', new THREE.InstancedBufferAttribute(lfPos, 3));
    // 拖尾材质 uniform：需要读前后两帧位置
    this.motionUniforms = {
      // 上一帧状态
      u_simPrevPosLifeTexture: this.simUniforms.u_simPrevPosLifeTexture,
      // 当前帧状态
      u_simCurrPosLifeTexture: this.simUniforms.u_simCurrPosLifeTexture,
      // 状态图尺寸
      u_simTextureSize: this.simUniforms.u_simTextureSize,
      // 拖尾强度（外部未修改，保持 1）
      u_strength: { value: 1 },
      // 屏幕宽高比：把像素位移换算到 uv 空间时需要
      u_aspect: { value: 1 },
    };
    // 拖尾网格
    this.motionMesh = new THREE.Mesh(
      // 实例化几何
      motionGeo,
      // 材质：顶点算屏幕速度，片元编码成 motion 纹理
      new THREE.ShaderMaterial({
        // uniform 表
        uniforms: this.motionUniforms,
        // 顶点（需 chunk：hash / rotate 工具）
        vertexShader: this.chunk(MOTION_VERT),
        // 片元
        fragmentShader: MOTION_FRAG,
      })
    );
    // 屏幕空间顶点，不做剔除
    this.motionMesh.frustumCulled = false;
    // 拖尾专用场景（单独渲染到低分辨率 motion RT）
    this.motionScene = new THREE.Scene();
    // 入场景
    this.motionScene.add(this.motionMesh);

    /* ── 粒子网格 ── */
    // 普通粒子（非发光）的实例 uv：跳过每行第 0 列，共 (W-1)*H 个
    const allUv = new Float32Array((W - 1) * H * 2);
    // 发光粒子的实例 uv：只取每行第 0 列（H 个），与 LF/MOTION 里 x<0.005 的约定一致
    const col0Uv = new Float32Array(H * 2);
    // 按行优先遍历状态图
    for (let p = 0, ai = 0, ci = 0; p < count; p++) {
      // 该粒子的 u
      const u = (p % W + 0.5) / W;
      // 该粒子的 v
      const v = (Math.floor(p / W) + 0.5) / H;
      // 第 0 列 → 发光组
      if (p % W === 0) {
        // 写入发光组 uv
        col0Uv[ci++] = u;
        // v
        col0Uv[ci++] = v;
      } else {
        // 其余 → 普通组
        allUv[ai++] = u;
        // v
        allUv[ai++] = v;
      }
    }
    // 普通粒子组几何
    this.geoNE = new THREE.InstancedBufferGeometry();
    // 实例属性：状态图采样点
    this.geoNE.setAttribute('simUv', new THREE.InstancedBufferAttribute(allUv, 2));
    // 发光粒子组几何
    this.geoE = new THREE.InstancedBufferGeometry();
    // 实例属性：状态图采样点（只有第 0 列）
    this.geoE.setAttribute('simUv', new THREE.InstancedBufferAttribute(col0Uv, 2));

    // 4 级球体 LOD：l / m / s / xs，粒子越大越用高模
    const ids = ['l', 'm', 's', 'xs'];
    // 并行加载 4 个 LOD 网格
    this.lods = await Promise.all(ids.map((id) => loadBuf(`/assets/models/about/sphere_${id}.buf`)));

    // 每组粒子的基础 uniform（复制一份，避免两组共享同一个对象导致互相覆盖）
    const baseUniforms = () => ({
      // 全局 shared
      ...this.shared,
      // 光照场 uniform（采样体积图集）
      ...this.lfUniforms,
      // sim uniform（读粒子状态）
      ...this.simUniforms,
      // 是否发光（0 = 普通）
      u_isEmissive: { value: 0 },
      // 发光占比（片元里决定输出 a 通道的混合权重）
      u_emissiveRatio: { value: 0 },
    });
    // 普通粒子 uniform
    const neUniforms = baseUniforms();
    // 普通粒子材质
    this.matNE = new THREE.ShaderMaterial({
      // uniform
      uniforms: neUniforms,
      // 顶点（需 chunk：lightFieldSlice / aboutHeroVisualFinal_vert）
      vertexShader: this.chunk(PARTICLE_VERT),
      // 片元（需 chunk：getScatter / getBlueNoise）
      fragmentShader: this.chunk(PARTICLE_FRAG),
    });
    // 发光粒子 uniform：在普通组基础上打开 isEmissive
    const eUniforms = { ...neUniforms, u_isEmissive: { value: 1 }, u_emissiveRatio: { value: 0 } };
    // 发光粒子材质
    this.matE = new THREE.ShaderMaterial({
      // uniform
      uniforms: eUniforms,
      // 顶点同上
      vertexShader: this.chunk(PARTICLE_VERT),
      // 片元同上
      fragmentShader: this.chunk(PARTICLE_FRAG),
    });

    // 普通粒子网格
    this.meshNE = new THREE.Mesh(this.geoNE, this.matNE);
    // 渲染顺序 5：最底层的天光/星云
    this.meshNE.renderOrder = 5;
    // 位置在 shader 里算，不做剔除
    this.meshNE.frustumCulled = false;
    // 发光粒子网格
    this.meshE = new THREE.Mesh(this.geoE, this.matE);
    // 同层渲染（顺序相同，靠深度/混合自然叠加）
    this.meshE.renderOrder = 5;
    // 不做剔除
    this.meshE.frustumCulled = false;
    // 两块网格一起加入容器
    this.container.add(this.meshNE, this.meshE);

    // LOD 缓存标记：-1 表示尚未应用过任何 LOD
    this._lodNE = -1;
    // 发光组的 LOD 缓存标记
    this._lodE = -1;
    // 初始：普通组用 m 级，发光组用 l 级（发光粒子更大，需要更细的球）
    this._applyLod(this.geoNE, this.lods[1], 0);
    // 发光组用 l 级
    this._applyLod(this.geoE, this.lods[0], 1);

    // 容器入主场景
    this.scene.add(this.container);
  }

  // 把某个 LOD 网格的 position/normal/uv 与索引换到目标几何上（instance 属性保留）
  _applyLod(geo, lodGeo, slot) {
    // 只搬这三类顶点属性（其余是实例属性，不能被覆盖）
    for (const k of ['position', 'normal', 'uv']) {
      // 存在才搬（有的 LOD 可能缺 uv）
      if (lodGeo.attributes[k]) geo.setAttribute(k, lodGeo.attributes[k]);
    }
    // 索引也要跟着换，否则拓扑与顶点数不匹配
    geo.setIndex(lodGeo.index);
    // 实例化属性必须保留
    // slot 0 = 普通组，重新绑回普通组的 simUv
    if (slot === 0) geo.setAttribute('simUv', this.geoNE.getAttribute('simUv'));
    // slot 1 = 发光组
    else geo.setAttribute('simUv', this.geoE.getAttribute('simUv'));
  }

  // 用全屏 quad 在一张 RT 上跑一次材质（GPGPU pass 的通用入口）
  _renderQuad(material, target) {
    // 渲染器简写
    const r = this.renderer;
    // 换上要执行的材质
    this._quad.material = material;
    // 绑定目标 RT
    r.setRenderTarget(target);
    // 渲染全屏 quad（相机无实际作用）
    r.render(this._quadScene, this._camera);
  }

  // 每帧：sim 步进 → emissive/LOD → 光照场清空/绘制/累积
  update(dt, introRatio, hudRatio, frozenDt = dt) {
    // 资源未就绪时直接跳过
    if (!this.matNE) return;
    // 共享 uniform 简写
    const shared = this.shared;
    // HUD 阶段（hudRatio>=1）整体隐藏粒子
    const visible = hudRatio < 1;
    // 容器显隐
    this.container.visible = visible;

    /* sim 步进（严格照搬原站顺序：先交换缓冲，再读 prev、写 curr）
     * 原站 AboutHeroParticlesSimulation.update：
     *   swap(curr, prev) → u_simPrev=prev（上一帧的状态）→ render 到 curr
     * 这样粒子顶点采样的 curr 与运动模糊的 prev/curr 差值都对应相邻两帧，
     * 否则状态链断裂会表现为双重曝光 + 拖尾暴走 + 静止闪烁。 */
    // 只有可见时才浪费算力做模拟
    if (visible) {
      // 交换缓冲：先把当前帧的 RT 暂存
      const swapTmp = this.simCurr;
      // curr ← prev（上一帧结果）
      this.simCurr = this.simPrev;
      // prev ← 刚才的 curr（本帧要写入的目标）
      this.simPrev = swapTmp;
      // 输入绑定：shader 读 prev
      this.simUniforms.u_simCurrPosLifeTexture.value = this.simCurr.texture;
      // 输出/参考绑定
      this.simUniforms.u_simPrevPosLifeTexture.value = this.simPrev.texture;
      // 原站 sim.update(e) 用的是未减速的 dt（子弹时间只减速 lightField/particles）
      this.simUniforms.u_introDeltaTime.value = dt;
      // 噪波时间推进：0.4 倍速让流场缓慢演化
      this.simUniforms.u_noiseTime.value += dt * 0.4;
      // 噪声强度的时间轴推进（1 倍速）
      this._noiseScaleTime += dt;
      // 噪波强度 = 10 × |3 层 fBm|，负半周期取绝对值避免反向
      this.simUniforms.u_noiseScale.value = 10 * Math.abs(this._noise.getFbm(this._noiseScaleTime, 3));
      // 稳定性噪声的时间轴推进（0.5 倍速）
      this._nsfTime += dt * 0.5;
      // 稳定性累积：只朝正方向增长（缓慢攀升，模拟原站「噪波稳定因子」）
      this._nsf += 0.05 * Math.abs(this._noise.getFbm(this._nsfTime, 3));
      // 最终稳定因子 = 入场进度映射 × 正弦平滑（0.9~0.95 之间窄幅波动）
      shared.u_noiseStableFactor.value =
        fit(introRatio, 0, 0.4, 0, 1) * smoothstep(0.9, 0.95, 0.5 + 0.5 * Math.sin(this._nsf));

      // 记录调用前的渲染目标（离开 GPGPU 后要还原）
      const prevTarget = this.renderer.getRenderTarget();
      // 跑一次 sim pass 到 curr
      this._renderQuad(this.simMaterial, this.simCurr);
      // 还原渲染目标
      this.renderer.setRenderTarget(prevTarget);
    }

    /* emissive 比例 + LOD */
    // 入场 0→0.2 期间发光占比从 0 升到 0.75（粒子先「点亮」再转入稳定态）
    const emissiveRatio = fit(introRatio, 0, 0.2, 0, 0.75);
    // 普通组写入发光占比
    this.matNE.uniforms.u_emissiveRatio.value = emissiveRatio;
    // 发光组写入同一占比（片元里用于 a 通道混合）
    this.matE.uniforms.u_emissiveRatio.value = emissiveRatio;

    // 入场早期（<0.3）：粒子远端、用低模
    const early = introRatio < 0.3;
    // 中段（0.3~0.7）
    const mid = !early && introRatio < 0.7;
    // 普通组 LOD 索引：早期 m、中段 s、后期 xs（粒子越大，LOD 越粗）
    const neIdx = early ? 1 : mid ? 2 : 3;
    // 发光组 LOD 索引：早期 l、中段 m、后期 xs
    const eIdx = early ? 0 : mid ? 1 : 3;
    // 只有变化时才换几何，避免每帧重建 attribute 绑定
    if (neIdx !== this._lodNE) {
      // 应用新 LOD
      this._applyLod(this.geoNE, this.lods[neIdx], 0);
      // 记录
      this._lodNE = neIdx;
    }
    // 发光组同理
    if (eIdx !== this._lodE) {
      // 应用新 LOD
      this._applyLod(this.geoE, this.lods[eIdx], 1);
      // 记录
      this._lodE = eIdx;
    }

    /* 光照场：清空 → 渲染粒子点 → 模糊/时间累积 */
    // 体积半尺寸（8×8×8 → 4,4,4）
    const half = this.VOLUME_SIZE.clone().multiplyScalar(0.5);
    // 体积中心 = -(半尺寸 - 光源位置)：让体积始终以光源为中心
    const center = half.sub(this.shared.u_lightPosition.value).multiplyScalar(-1);
    // 体积世界偏移 = -体素半宽 + 上面的中心修正（保证网格与体素中心对齐）
    this.lfUniforms.u_lightFieldVolumeOffset.value.setScalar(-this.gridSize / 2).add(center);

    // 渲染器简写
    const r = this.renderer;
    // 保存渲染目标
    const prevTarget = r.getRenderTarget();
    // 保存清屏色
    const prevColor = r.getClearColor(new THREE.Color());
    // 保存清屏 alpha
    const prevAlpha = r.getClearAlpha();

    // 切到「已绘制」RT
    r.setRenderTarget(this.lfDrawn);
    // 清成透明黑（等价于「本帧还没有任何光照」）
    r.setClearColor(0x000000, 0);
    // 只清颜色
    r.clear(true, false, false);
    // 把粒子点画进图集（Max 混合）
    r.render(this.lfScene, this._camera);
    // 还原渲染目标
    r.setRenderTarget(prevTarget);
    // 还原清屏色
    r.setClearColor(prevColor, prevAlpha);

    // 交换 curr / prev：写进「上一帧」那张，读另一张
    const tmp = this.lfCurr;
    // 先让 curr 指向旧 prev
    this.lfCurr = this.lfPrev;
    // 旧 curr 变成新的 prev
    this.lfPrev = tmp;
    // 采样纹理指向新 curr
    this.lfUniforms.u_lightFieldSlicedTexture.value = this.lfCurr.texture;
    // 混合材质读新 prev
    this.lfBlendMaterial.uniforms.u_prevSliceTexture.value = this.lfPrev.texture;
    // 保存渲染目标（混合 pass 要切走再切回）
    const prev2 = r.getRenderTarget();
    // 跑混合 pass 写入 curr
    this._renderQuad(this.lfBlendMaterial, this.lfCurr);
    // 还原
    r.setRenderTarget(prev2);
  }

  // 释放所有 RT / 材质 / 几何 / LOD
  dispose() {
    // sim 双缓冲
    this.simRT?.forEach((rt) => rt.dispose());
    // 光照场三缓冲
    this.lfRT?.forEach((rt) => rt.dispose());
    // sim 材质
    this.simMaterial?.dispose();
    // 拷贝材质
    this.copyMaterial?.dispose();
    // 光照场混合材质
    this.lfBlendMaterial?.dispose();
    // 光照场点集几何
    this.lfMesh?.geometry.dispose();
    // 光照场点集材质
    this.lfMesh?.material.dispose();
    // 拖尾几何
    this.motionMesh?.geometry.dispose();
    // 拖尾材质
    this.motionMesh?.material.dispose();
    // 普通粒子材质
    this.meshNE?.material.dispose();
    // 发光粒子材质
    this.meshE?.material.dispose();
    // 普通粒子几何
    this.geoNE?.dispose();
    // 发光粒子几何
    this.geoE?.dispose();
    // 全屏 quad 几何
    this._quad?.geometry.dispose();
    // 4 个 LOD 网格（可能没有 dispose 方法，用可选调用）
    this.lods?.forEach((g) => g.dispose?.());
  }
}
