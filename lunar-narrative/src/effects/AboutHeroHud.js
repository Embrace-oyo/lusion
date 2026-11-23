/**
 * AboutHeroHud.js — about 页 HUD 阶段的线条与字母层
 *
 * 逆向依据（bundle）：
 *   AboutHeroLines   @990477  terrain_lines.buf → 3 边管状线，Max 混合，沿长度流动
 *   AboutHeroLetters @1023429 letter_placements.buf + font.png → 4 组实例字母，
 *                             离屏渲染后逐级 blur(16/8/4)，再用全屏加法叠回场景
 */

import * as THREE from 'three';
import { loadBuf } from '../core/BufLoader.js';

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/* 线条顶点着色器（逆向自 AboutHeroLines 的 vert）：
 *   t            —— 顶点沿整条折线的弧长（累加长度，单位与地形世界坐标一致）
 *   totalLength  —— 所属折线的总弧长，配合 u_time 做 mod 循环流动
 *   lineId       —— 第几条折线（terrain_lines 被 THRESHOLDS 切成多段）
 * 几何体本身是把折线挤出成「三角形管」：每个路径点生成 SEGMENT_COUNT 个环点，
 * 法线方向由绕切线旋转 120° 得到，因此这里用 yIndex%4 区分粗管 / 细管两类。 */
const LINE_VERT = /* glsl */ `attribute float t;attribute float totalLength;attribute float lineId;varying float v_t;varying float v_totalLength;varying float v_thicknessRatio;varying vec3 v_viewNormal;varying vec3 v_worldNormal;varying vec3 v_worldPosition;vec3 inverseTransformDirection(in vec3 dir,in mat4 matrix){return normalize((vec4(dir,0.0)*matrix).xyz);}void main(){v_t=t;v_totalLength=totalLength;float yIndex=floor(position.y+.5);v_thicknessRatio=step(mod(yIndex,4.),0.5);vec3 pos=position+normal*mix(0.04,0.1,v_thicknessRatio);vec3 nor=normalize(normalMatrix*normal);v_viewNormal=nor;v_worldNormal=inverseTransformDirection(nor,viewMatrix);v_worldPosition=(modelMatrix*vec4(pos,1.0)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(pos,1.0);gl_Position.z-=0.1/gl_Position.w;}`;
/* 线条片元着色器（逆向自 AboutHeroLines 的 frag），要点：
 *   1) t' = mod(t - u_time*2, totalLength) —— 让「亮段」沿折线持续流动（2 = 流动速度）
 *   2) 用 2D pnoise 沿弧长采样，只在噪声波峰处提亮，形成沿线的电流/等高线感
 *   3) shade 用 linearStep(50, -20, worldZ) 做纵深衰减（越靠后越暗，制造景深）
 *   4) 末尾 step(totalLength - t, totalLength*u_hudRatio) —— HUD 阶段按比例自上而下显影
 *   5) 输出是 (r=亮度, g=0, b=远处补蓝, a=1)，配合 MaxEquation 叠加，因此不做透明混合 */
const LINE_FRAG = /* glsl */ `uniform float u_time;uniform float u_hudRatio;varying float v_t;varying float v_totalLength;varying float v_thicknessRatio;varying vec3 v_viewNormal;varying vec3 v_worldNormal;varying vec3 v_worldPosition;vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}vec2 fade(vec2 t){return t*t*t*(t*(t*6.0-15.0)+10.0);}float pnoise(vec2 P,vec2 rep){vec4 Pi=floor(P.xyxy)+vec4(0.0,0.0,1.0,1.0);vec4 Pf=fract(P.xyxy)-vec4(0.0,0.0,1.0,1.0);Pi=mod(Pi,rep.xyxy);Pi=mod289(Pi);vec4 ix=Pi.xzxz;vec4 iy=Pi.yyww;vec4 fx=Pf.xzxz;vec4 fy=Pf.yyww;vec4 i=permute(permute(ix)+iy);vec4 gx=fract(i*(1.0/41.0))*2.0-1.0;vec4 gy=abs(gx)-0.5;vec4 tx=floor(gx+0.5);gx=gx-tx;vec2 g00=vec2(gx.x,gy.x);vec2 g10=vec2(gx.y,gy.y);vec2 g01=vec2(gx.z,gy.z);vec2 g11=vec2(gx.w,gy.w);vec4 norm=taylorInvSqrt(vec4(dot(g00,g00),dot(g01,g01),dot(g10,g10),dot(g11,g11)));g00*=norm.x;g01*=norm.y;g10*=norm.z;g11*=norm.w;float n00=dot(g00,vec2(fx.x,fy.x));float n10=dot(g10,vec2(fx.y,fy.y));float n01=dot(g01,vec2(fx.z,fy.z));float n11=dot(g11,vec2(fx.w,fy.w));vec2 fade_xy=fade(Pf.xy);vec2 n_x=mix(vec2(n00,n01),vec2(n10,n11),fade_xy.x);float n_xy=mix(n_x.x,n_x.y,fade_xy.y);return 2.3*n_xy;}float linearStep(float edge0,float edge1,float x){return clamp((x-edge0)/(edge1-edge0),0.0,1.0);}void main(){float t=mod(v_t-u_time*2.,v_totalLength);float noiseScale=0.25;float n=pnoise(vec2(t*noiseScale,0.),vec2(v_totalLength*noiseScale,100.));float shade=mix(0.3+smoothstep(0.,0.-fwidth(n),n)*0.6,1.,v_thicknessRatio);shade*=linearStep(50.,-20.,v_worldPosition.z);gl_FragColor=vec4(shade,0.,0.,1.)*step(v_totalLength-v_t,v_totalLength*u_hudRatio);gl_FragColor.b=linearStep(15.,66.,v_worldPosition.z);gl_FragColor.r*=.85;}`;
/* 字母顶点着色器（逆向自 AboutHeroLetters 的 vert）：
 * 每个实例 = 一颗「竖向字条」，position 是单位面片，instancePos 来自 letter_placements.buf。
 *   charCount = mix(50, 100, rand.y)  —— 字条竖向排列多少个字符位
 *   v_charUv  —— 把面片 uv 映射到字条内的字符网格坐标（x 翻转，y 乘 charCount）
 *   v_charUv.y -= u_time * mix(2,10,rand.x) —— 字符沿字条向下滚动，速度逐实例随机
 *   v_opacity = mix(.5,1,density) * u_showRatio —— density 是原站布局密度，控制明暗 */
const LETTER_VERT = /* glsl */ `attribute vec3 instancePos;attribute vec4 instanceRands;attribute float instanceDensity;uniform float u_time;uniform float u_showRatio;varying vec2 v_uv;varying vec2 v_charUv;varying vec3 v_worldPosition;varying vec4 v_instanceRands;varying float v_opacity;void main(){float charCount=mix(50.,100.,instanceRands.y);vec3 pos=position;v_uv=uv;pos.xy*=vec2(1.,6./5.*charCount);v_charUv=vec2(1.-position.x,position.y*charCount)+vec2(.5,0.);v_charUv.y-=u_time*mix(2.,10.,instanceRands.x);pos=pos*0.75+instancePos;gl_Position=projectionMatrix*modelViewMatrix*vec4(pos,1.);v_worldPosition=(modelMatrix*vec4(pos,1.)).xyz;v_instanceRands=instanceRands;v_opacity=mix(.5,1.,instanceDensity)*u_showRatio;}`;
/* 字母片元着色器（逆向自 AboutHeroLetters 的 frag）：
 * 字体图集 font.png 是横向 42 个字形的图集（MAX_CHAR = 42）。
 *   charIdx  —— 当前字符格索引，按 charTime 用 hash43 随机跳字符 → 乱码闪变效果
 *   charUv   —— (x+charIdx)/MAX_CHAR 取到具体字形，mod(y,1) 保证在字条内重复
 * 调色全部走乘法（不混合）：charRands 控制闪变亮度，smoothstep 在字条上下端淡出，
 * 结尾 smoothstep(100,150, mod(...)) 让字条沿长度方向分段显隐，避免整条死板。 */
const LETTER_FRAG = /* glsl */ `uniform sampler2D u_letterTexture;uniform float u_time;varying vec2 v_charUv;varying vec2 v_uv;varying vec3 v_worldPosition;varying vec4 v_instanceRands;varying float v_opacity;float linearStep(float edge0,float edge1,float x){return clamp((x-edge0)/(edge1-edge0),0.0,1.0);}vec4 hash43(vec3 p){vec4 p4=fract(vec4(p.xyzx)*vec4(.1031,.1030,.0973,.1099));p4+=dot(p4,p4.wzxy+33.33);return fract((p4.xxyz+p4.yzzw)*p4.zywx);}void main(){float fade=1.-linearStep(15.,66.,v_worldPosition.z);float MAX_CHAR=42.;float charIdx=floor(mod(v_charUv.y,MAX_CHAR));float charTime=u_time*mix(1.,2.,v_instanceRands.y+hash43(vec3(charIdx,-100.,v_instanceRands.z)).x);vec4 charRands=hash43(vec3(charIdx,v_instanceRands.w,floor(charTime*-2.)));charIdx=mod(charIdx+floor(charRands.x*MAX_CHAR),MAX_CHAR);vec2 charUv=vec2((v_charUv.x+charIdx)/MAX_CHAR,mod(v_charUv.y,1.));float shade=texture2D(u_letterTexture,charUv).r;gl_FragColor=vec4(shade)*charRands.w*charRands.y*v_opacity;gl_FragColor*=smoothstep(0.5,0.35,abs(v_uv.y-.5))*(0.5+fade*0.5)*(0.3+v_instanceRands.z*1.25)*smoothstep(100.,150.,mod(v_charUv.y-200.*v_instanceRands.y,200.));gl_FragColor.a*=3.;}`;

/* HUD 人脸顶点着色器（逆向自 AboutHeroFaces 的 vert，原站 bundle 里是 AboutHero 的人像粒子层）：
 * 数据流：team/<id>.buf（128×64 个点）→ position/nShade 两张 DataTexture
 *   u_positionTexture  : xyz = 缩放前的点位置，w = 1/FACE_COUNT（用于累积归一）
 *   u_norShadeTexture  : xyz = 法线（0..1 编码），w = 预烘焙的明暗/体积光
 * a_simUv 是该实例在纹理中的采样点；a_rands1/2 是逐点随机数。
 * 关键步骤：
 *   showRatio —— 按 y（高度）与随机阈值做错峰出现，实现「自下而上扫描式点亮」
 *   pos *= 1.3 后叠加 simplex 噪声位移 * (1-showRatio)，即未出现时散开
 *   光照     —— 以 u_mouse（世界空间点光源）为光源，1/sqrt(dist) 衰减 + 正面朝向裁剪
 *   v_blurriness —— 依据「点当前位置与活跃平面距离」计算散焦，再据此放大点尺寸，
 *                   并用 subpixelMultiplier 补偿尺寸放大后的亮度守恒（类似 DOF 能量归一）
 *   故障效果 —— verticalRands 按 y 分带抽随机行，超过 u_glitchThreshold 才水平抖动
 * 输出 v_shade 交给片元画圆形点精灵（四边形 + 中心距离淡出）。 */
const FACE_VERT = /* glsl */ `uniform sampler2D u_positionTexture;uniform sampler2D u_norShadeTexture;uniform float u_activeRatio;uniform float u_showRatio;uniform vec3 u_mouse;uniform vec2 u_resolution;uniform float u_time;uniform float u_isForward;uniform float u_glitchOffset;uniform float u_glitchStrength;uniform float u_glitchThreshold;attribute vec2 a_simUv;attribute vec4 a_rands1;attribute vec4 a_rands2;varying float v_shade;varying float v_showRatio;varying float v_blurriness;varying vec2 v_toCenter;varying vec2 v_uv;varying vec3 v_color;vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}float mod289(float x){return x-floor(x*(1.0/289.0))*289.0;}vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}float permute(float x){return mod289(((x*34.0)+1.0)*x);}vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}float taylorInvSqrt(float r){return 1.79284291400159-0.85373472095314*r;}vec4 grad4(float j,vec4 ip){const vec4 ones=vec4(1.0,1.0,1.0,-1.0);vec4 p,s;p.xyz=floor(fract(vec3(j)*ip.xyz)*7.0)*ip.z-1.0;p.w=1.5-dot(abs(p.xyz),ones.xyz);s=vec4(lessThan(p,vec4(0.0)));p.xyz=p.xyz+(s.xyz*2.0-1.0)*s.www;return p;}
#define F4 0.309016994374947451
vec4 simplexNoiseDerivatives(vec4 v){const vec4 C=vec4(0.138196601125011,0.276393202250021,0.414589803375032,-0.447213595499958);vec4 i=floor(v+dot(v,vec4(F4)));vec4 x0=v-i+dot(i,C.xxxx);vec4 i0;vec3 isX=step(x0.yzw,x0.xxx);vec3 isYZ=step(x0.zww,x0.yyz);i0.x=isX.x+isX.y+isX.z;i0.yzw=1.0-isX;i0.y+=isYZ.x+isYZ.y;i0.zw+=1.0-isYZ.xy;i0.z+=isYZ.z;i0.w+=1.0-isYZ.z;vec4 i3=clamp(i0,0.0,1.0);vec4 i2=clamp(i0-1.0,0.0,1.0);vec4 i1=clamp(i0-2.0,0.0,1.0);vec4 x1=x0-i1+C.xxxx;vec4 x2=x0-i2+C.yyyy;vec4 x3=x0-i3+C.zzzz;vec4 x4=x0+C.wwww;i=mod289(i);float j0=permute(permute(permute(permute(i.w)+i.z)+i.y)+i.x);vec4 j1=permute(permute(permute(permute(i.w+vec4(i1.w,i2.w,i3.w,1.0))+i.z+vec4(i1.z,i2.z,i3.z,1.0))+i.y+vec4(i1.y,i2.y,i3.y,1.0))+i.x+vec4(i1.x,i2.x,i3.x,1.0));vec4 ip=vec4(1.0/294.0,1.0/49.0,1.0/7.0,0.0);vec4 p0=grad4(j0,ip);vec4 p1=grad4(j1.x,ip);vec4 p2=grad4(j1.y,ip);vec4 p3=grad4(j1.z,ip);vec4 p4=grad4(j1.w,ip);vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;p4*=taylorInvSqrt(dot(p4,p4));vec3 values0=vec3(dot(p0,x0),dot(p1,x1),dot(p2,x2));vec2 values1=vec2(dot(p3,x3),dot(p4,x4));vec3 m0=max(0.5-vec3(dot(x0,x0),dot(x1,x1),dot(x2,x2)),0.0);vec2 m1=max(0.5-vec2(dot(x3,x3),dot(x4,x4)),0.0);vec3 temp0=-6.0*m0*m0*values0;vec2 temp1=-6.0*m1*m1*values1;vec3 mmm0=m0*m0*m0;vec2 mmm1=m1*m1*m1;float dx=temp0[0]*x0.x+temp0[1]*x1.x+temp0[2]*x2.x+temp1[0]*x3.x+temp1[1]*x4.x+mmm0[0]*p0.x+mmm0[1]*p1.x+mmm0[2]*p2.x+mmm1[0]*p3.x+mmm1[1]*p4.x;float dy=temp0[0]*x0.y+temp0[1]*x1.y+temp0[2]*x2.y+temp1[0]*x3.y+temp1[1]*x4.y+mmm0[0]*p0.y+mmm0[1]*p1.y+mmm0[2]*p2.y+mmm1[0]*p3.y+mmm1[1]*p4.y;float dz=temp0[0]*x0.z+temp0[1]*x1.z+temp0[2]*x2.z+temp1[0]*x3.z+temp1[1]*x4.z+mmm0[0]*p0.z+mmm0[1]*p1.z+mmm0[2]*p2.z+mmm1[0]*p3.z+mmm1[1]*p4.z;float dw=temp0[0]*x0.w+temp0[1]*x1.w+temp0[2]*x2.w+temp1[0]*x3.w+temp1[1]*x4.w+mmm0[0]*p0.w+mmm0[1]*p1.w+mmm0[2]*p2.w+mmm1[0]*p3.w+mmm1[1]*p4.w;return vec4(dx,dy,dz,dw)*49.0;}vec4 hash42(vec2 p){vec4 p4=fract(vec4(p.xyxy)*vec4(.1031,.1030,.0973,.1099));p4+=dot(p4,p4.wzxy+33.33);return fract((p4.xxyz+p4.yzzw)*p4.zywx);}float linearStep(float edge0,float edge1,float x){return clamp((x-edge0)/(edge1-edge0),0.0,1.0);}vec3 inverseTransformDirection(in vec3 dir,in mat4 matrix){return normalize((vec4(dir,0.0)*matrix).xyz);}void main(){vec3 basePos=texture2D(u_positionTexture,a_simUv).xyz;vec3 pos=basePos;float yRatio=basePos.y*0.5+0.5;float showRatio=smoothstep(a_rands1.x*0.2+yRatio*0.4,0.4+a_rands1.y*0.2+yRatio*0.4,u_showRatio);pos*=1.3;pos+=(simplexNoiseDerivatives(vec4(basePos*8.,u_time)).yzw*0.2+vec3(1.*yRatio,0.0,-1.))*(1.-showRatio);v_showRatio=showRatio;vec4 norShade=texture2D(u_norShadeTexture,a_simUv);float depth=clamp(1.-pos.z,0.0,1.0);vec3 nor=norShade.xyz*2.-1.;vec3 worldPosition=(modelMatrix*vec4(pos,1.0)).xyz;vec3 viewNormal=normalMatrix*normalize(nor);vec3 worldNormal=inverseTransformDirection(viewNormal,viewMatrix);vec3 lightDir=normalize(u_mouse-worldPosition);float distToLight=distance(u_mouse,worldPosition);float light=norShade.w*1.25;float diff=linearStep(0.35,1.0,dot(worldNormal,lightDir))/sqrt(distToLight*0.1);light*=diff+0.6;light+=(0.05+diff*0.15)*smoothstep(0.0,0.005,norShade.w);float frontFaceMultiplier=linearStep(-0.2,0.0,viewNormal.z);light*=frontFaceMultiplier;v_blurriness=min(1.0,(abs(depth-(1.-u_activeRatio*showRatio)*0.5))*2.5)*(2.-showRatio);float basePointSize=0.009*(1.+pow(v_blurriness,1.5)*8.)*frontFaceMultiplier;float pointSize=max(basePointSize,12./u_resolution.y);float subpixelMultiplier=pow(basePointSize/pointSize,1.5);pos.xy+=position.xy*pointSize*step(0.003,light)*linearStep(0.0,0.75,u_activeRatio);vec4 verticalRands=hash42(vec2(floor(basePos.y*3.+cos(basePos.y*3.+u_glitchOffset)*2.+u_glitchOffset),0.))*u_glitchStrength;float glitchWeight=verticalRands.x*step(u_glitchThreshold,verticalRands.y);pos.x+=(verticalRands.z*verticalRands.z)*glitchWeight*0.35*cos(basePos.y+u_glitchOffset);gl_Position=projectionMatrix*modelViewMatrix*vec4(pos,1.0);v_color=mix(vec3(1.0),(viewNormal.xzy*0.5+0.5)*vec3(1.0,0.5,2.0),glitchWeight);light*=(1.+glitchWeight*1.5);light+=0.1*glitchWeight;float scanline=smoothstep(0.04,0.,abs(fract(u_time*-0.3-basePos.y*.5+.5)));light+=scanline*(0.25*norShade.w*(1.0-light)+smoothstep(0.03,0.,abs(viewNormal.z)));v_shade=min(1.0,light*(1.-v_blurriness*0.5))*subpixelMultiplier*showRatio;v_toCenter=(uv-.5)*2.;v_uv=uv;}`;
/* 人脸片元着色器（逆向自 AboutHeroFaces 的 frag）：
 * 四边形被当作点精灵：d = 到面片中心的距离，range 由 v_blurriness 放大 → 圆形软边；
 * 亮度再做一次线性衰减，最后乘 v_showRatio² ，并用 pow(1-blurriness,3) 保持能量，
 * 从而在「实焦小点」与「虚焦大散景」之间平滑过渡（原站同样用平方做软过渡）。 */
const FACE_FRAG = /* glsl */ `varying float v_shade;varying float v_showRatio;varying vec2 v_toCenter;varying float v_blurriness;varying vec2 v_uv;varying vec3 v_color;float linearStep(float edge0,float edge1,float x){return clamp((x-edge0)/(edge1-edge0),0.0,1.0);}vec3 linearStep(vec3 edge0,vec3 edge1,vec3 x){return clamp((x-edge0)/(edge1-edge0),vec3(0.),vec3(1.));}void main(){float shade=v_shade;float d=length(v_toCenter);float range=v_blurriness*5.;float brightness=linearStep(1.,1.-range-fwidth(d),d);shade*=brightness*(1.25-v_blurriness*v_shade);gl_FragColor=vec4(shade)*v_showRatio*v_showRatio;gl_FragColor.a*=pow(1.-v_blurriness,3.)*0.8*linearStep(0.8,1.0,v_showRatio*v_showRatio);}`;

/* 可分离 9-tap 高斯模糊（权重和 = 1.0，中心 0.1633）：
 * 一次只沿 u_delta 方向采样，调用方做水平 + 垂直两遍即得 2D 模糊；
 * 字母层依次用 16/8/4 三种半径，等价于原站的逐级 mip 模糊金字塔。 */
const BLUR9_FRAG = /* glsl */ `
// 源纹理与单步偏移量（偏移量已按目标分辨率换算成 uv 单位）
uniform sampler2D u_texture;
uniform vec2 u_delta;
varying vec2 v_uv;
void main() {
  // 中心权重最大，向两侧逐级递减：0.1633 / 0.1531 / 0.12245 / 0.0918 / 0.051
  vec4 color = texture2D(u_texture, v_uv) * 0.1633;
  vec2 delta = u_delta;
  // 第 1 圈：中心两侧各取一次
  color += texture2D(u_texture, v_uv - delta) * 0.1531;
  color += texture2D(u_texture, v_uv + delta) * 0.1531;
  // 步长累加，第 2 圈（2 倍偏移）
  delta += u_delta;
  color += texture2D(u_texture, v_uv - delta) * 0.12245;
  color += texture2D(u_texture, v_uv + delta) * 0.12245;
  // 第 3 圈（3 倍偏移）
  delta += u_delta;
  color += texture2D(u_texture, v_uv - delta) * 0.0918;
  color += texture2D(u_texture, v_uv + delta) * 0.0918;
  // 第 4 圈（4 倍偏移）
  delta += u_delta;
  color += texture2D(u_texture, v_uv - delta) * 0.051;
  color += texture2D(u_texture, v_uv + delta) * 0.051;
  // 9 次采样加权求和结果
  gl_FragColor = color;
}
`;

/* 原站 SEGMENT_COUNT / THREHSOLDS：把 terrain_lines 拆成多条折线 */
// 管的截面边数：3 → 三角形管，省顶点又足够形成细线的高光
const SEGMENT_COUNT = 3;
// 每条折线在 terrain_lines 顶点数组中的结束下标（相邻两项之差 = 该段顶点数）
const THRESHOLDS = [60, 245, 806, 966, 991, 1026, 1191, 1853, 2061, 3111, 4279, 4309, 4338, 5265, 5316, 5447, 5475, 6407, 6445, 7116, 7235, 7349, 7934, 8555, 8583, 8614, 9154, 9640, 9688, 10163, 10420, 10645, 10895, 11074, 11286, 11453, 11596, 11628, 11740, 11799, 11832];

/* ── HUD 人脸：team/*.buf 的 8192 个点 → 实例四边形 ── */
// 7 位团队成员的 buf 文件名（每个都是一张 128×64 的点云 + 法线/明暗贴图）
const TEAM_IDS = ['edan', 'ffi', 'pierre', 'yannic', 'paul', 'andrii', 'sunny'];
// 点云纹理宽度（= 每行点数），与 DATA 的排版一致
const FACE_W = 128;
// 点云纹理高度（= 行数）
const FACE_H = 64;
// 点总数 = 128*64 = 8192，与 team/*.buf 的顶点数一一对应
const FACE_COUNT = FACE_W * FACE_H;

// HUD 人脸层：7 位成员的点云人像，按「定时轮换 + 平滑过渡」播放（原站由点击/滑动驱动）
export class AboutHeroFaces {
  constructor({ camera, shared, withChunks }) {
    // 主相机：既用于 unproject 求鼠标世界位置，也参与每帧渲染
    this.camera = camera;
    // 全局共享 uniform（时间 / 场景比例等），通过展开合并进每个材质
    this.shared = shared;
    // chunk 注入函数（把 #include <xxx> 替换成源码片段）
    this.chunk = withChunks;
    // 每位成员的位置纹理：id → DataTexture(RGBA Float)
    this.posTextures = {};
    // 每位成员的法线 + 明暗纹理：id → DataTexture(RGBA UnsignedByte)
    this.norTextures = {};
    // 当前正在显示的成员 id
    this.currId = '';
    // 正在过渡进来的下一位成员 id
    this.nextId = '';
    // 过渡进度 0..1（0 = 完全 curr，1 = 完全 next）
    this.transitionRatio = 0;
    // 整体出场比例 0..1（HUD 阶段淡入）
    this.showRatio = 0;
    // 是否处于可见区间（showRatio > 0 才算激活）
    this.isActive = false;
    // 内部激活动画比例：从 0 缓动到 1，控制点精灵是否已经「站定」
    this.activeRatio = 1;
    // 只属于人脸层的 uniform（不放进全局 shared，避免其它材质被污染）
    this.sharedUniforms = {
      // 世界空间点光源位置：每帧由鼠标射线算出，用于给人脸打光
      u_mouse: { value: new THREE.Vector3() },
      // 故障抖动的相位偏移（每帧随机，避免所有帧抖动模式相同）
      u_glitchOffset: { value: 0 },
      // 故障抖动强度（随机 0..1，等价于原站随机 glitch 概率）
      u_glitchStrength: { value: 0 },
      // 出场比例，与 u_showRatio 同名但作用在人脸这一层
      u_showRatio: { value: 0 },
    };
    // 人脸层独立场景：不加入主场景，只在其可见时手动叠加渲染
    this.scene = new THREE.Scene();
    // 人脸整体容器：统一缩放/旋转/位移，把 8192 个点的局部坐标摆到镜头正前方
    this.container = new THREE.Group();
    // 非等比缩放：Y 方向略压、Z 方向拉伸，轻微仰视的人像轮廓
    this.container.scale.set(27.5, 27.5, 16);
    // 绕 Y 轴转 180°+0.2，让人脸正对相机但带一点侧转（原站构图）
    this.container.rotation.y = Math.PI + 0.2;
    // 略低头，配合相机高度
    this.container.rotation.x = 0.1;
    // 抬高 34、后退 25：位于地面之上、相机前方的中景
    this.container.position.set(0, 34, 25);
    // 容器入场景
    this.scene.add(this.container);
    // 两块网格交替：A 显示当前成员、B 显示下一位，靠 activeRatio 交叉溶解
    this.meshArray = [];
    // 复用向量：每帧 unproject 鼠标射线，避免 GC
    this._v = new THREE.Vector3();
    // 复用矩阵：容器世界矩阵的逆，用于把世界点变换回容器的局部空间
    this._m = new THREE.Matrix4();
  }

  // 加载 7 位成员的点云，构造两张数据纹理 + 两块可交叉溶解的实例化网格
  async load() {
    // 单位面片作为点精灵的载体（实际尺寸在顶点着色器里按 pointSize 缩放）
    const plane = new THREE.PlaneGeometry(1, 1);
    // 实例化几何：面片属性共享，实例属性（simUv / 随机数）每个点一份
    const geo = new THREE.InstancedBufferGeometry();
    // 把面片的 position/normal/uv 原样搬过来
    for (const [k, v] of Object.entries(plane.attributes)) geo.setAttribute(k, v);
    // 索引也照搬，保证三角形拓扑一致
    geo.setIndex(plane.index);
    // 每个实例在点云纹理中的采样 uv（2 个 float：u,v）
    const simUv = new Float32Array(FACE_COUNT * 2);
    // 第一组逐实例随机数（xyz 用于确定性偏移、w 用于其它分层）
    const rands1 = new Float32Array(FACE_COUNT * 4);
    // 第二组逐实例随机数（原站 a_rands2，本移植未在 shader 里使用，但保持数据对齐）
    const rands2 = new Float32Array(FACE_COUNT * 4);
    // 线性铺满 128×64：第 i 个点对应纹理中的 (i%W, floor(i/W))
    for (let i = 0, a = 0, b = 0; i < FACE_COUNT; i++, a += 2, b += 4) {
      // 取像素中心 +0.5，避免线性采样落在像素边界上
      simUv[a] = (i % FACE_W + 0.5) / FACE_W;
      // 行方向同理（行号 / 行数）
      simUv[a + 1] = (Math.floor(i / FACE_W) + 0.5) / FACE_H;
      // 每个点 4 个随机数，供着色器做逐点差异化
      for (let k = 0; k < 4; k++) {
        // 第一组随机
        rands1[b + k] = Math.random();
        // 第二组随机
        rands2[b + k] = Math.random();
      }
    }
    // 注册实例属性：采样点 uv
    geo.setAttribute('a_simUv', new THREE.InstancedBufferAttribute(simUv, 2));
    // 注册实例属性：随机组 1
    geo.setAttribute('a_rands1', new THREE.InstancedBufferAttribute(rands1, 4));
    // 注册实例属性：随机组 2
    geo.setAttribute('a_rands2', new THREE.InstancedBufferAttribute(rands2, 4));

    // 逐位成员把 buf 解包成两张 128×64 的浮点纹理
    for (const id of TEAM_IDS) {
      // 加载点云：position（xyz + 可能附带额外通道）与 nShade（法线 + 明暗）
      const buf = await loadBuf(`/assets/team/${id}.buf`);
      // 源位置数组，每 3 个 float 一个点
      const src = buf.attributes.position.array;
      // 目标纹理数据：RGBA Float，每点 4 个分量（xyz + 1/FACE_COUNT）
      const pos = new Float32Array(FACE_COUNT * 4);
      // 逐点搬运：a 指向源（步长 3），b 指向目标（步长 4）
      for (let i = 0, a = 0, b = 0; i < FACE_COUNT; i++, a += 3, b += 4) {
        // x
        pos[b] = src[a];
        // y
        pos[b + 1] = src[a + 1];
        // z
        pos[b + 2] = src[a + 2];
        // w 存归一化权重，供着色器做能量累积（原站同为 1/FACE_COUNT）
        pos[b + 3] = 1 / FACE_COUNT;
      }
      // 位置纹理：浮点精度，避免点云被量化成阶梯
      const posTex = new THREE.DataTexture(pos, FACE_W, FACE_H, THREE.RGBAFormat, THREE.FloatType);
      // 最近邻采样：点位是一一对应的数据，不能被插值平滑
      posTex.minFilter = posTex.magFilter = THREE.NearestFilter;
      // 通知 GPU 上传
      posTex.needsUpdate = true;
      // 按成员 id 缓存
      this.posTextures[id] = posTex;

      // 法线/明暗纹理：UnsignedByte 足够，省显存与带宽（0..255 → 0..1）
      const norTex = new THREE.DataTexture(buf.attributes.nShade.array, FACE_W, FACE_H, THREE.RGBAFormat, THREE.UnsignedByteType);
      // 同样用最近邻，保证法线与点位严格对齐
      norTex.minFilter = norTex.magFilter = THREE.NearestFilter;
      // 上传
      norTex.needsUpdate = true;
      // 缓存
      this.norTextures[id] = norTex;
    }

    // 建两块网格：槽位 0 = 当前成员，槽位 1 = 下一位成员
    for (let i = 0; i < 2; i++) {
      // 每个槽位独立材质（uniform 里的 activeRatio / 纹理不同）
      const mat = new THREE.ShaderMaterial({
        // uniform 表：全局 shared + 人脸层私有 + 每槽位私有
        uniforms: {
          // 展开全局共享 uniform（u_time / u_sceneRatio 等）
          ...this.shared,
          // 点光源位置（两块网格共享同一个对象，鼠标一动就同步）
          u_mouse: this.sharedUniforms.u_mouse,
          // 故障相位
          u_glitchOffset: this.sharedUniforms.u_glitchOffset,
          // 故障强度
          u_glitchStrength: this.sharedUniforms.u_glitchStrength,
          // 出场比例
          u_showRatio: this.sharedUniforms.u_showRatio,
          // 触发故障的阈值（0..0.9，来自 activeRatio 的映射）
          u_glitchThreshold: { value: 0 },
          // 槽位激活动画比例（1-t / t）
          u_activeRatio: { value: 0 },
          // 当前槽位对应的位置纹理（update 时按成员切换）
          u_positionTexture: { value: null },
          // 当前槽位对应的法线/明暗纹理
          u_norShadeTexture: { value: null },
        },
        // 顶点着色器需要 chunk 注入（simplex / hash / linearStep 等工具函数）
        vertexShader: this.chunk(FACE_VERT),
        // 片元着色器无 include，直接用原文
        fragmentShader: FACE_FRAG,
        // 关掉深度测试：人脸是叠加在场景之上的特效层
        depthTest: false,
        // 不写深度，避免影响后续透明叠加
        depthWrite: false,
        // 标记透明，交给 GPU 按自定义混合处理
        transparent: true,
        // 用自定义混合而不是 three 预设（原站是纯加法累积）
        blending: THREE.CustomBlending,
        // 颜色/alpha 都做加法：src + dst
        blendEquation: THREE.AddEquation,
        // 源因子 1
        blendSrc: THREE.OneFactor,
        // 目标因子 1
        blendDst: THREE.OneFactor,
        // alpha 通道同样做加法
        blendEquationAlpha: THREE.AddEquation,
        // 源 alpha 因子 1
        blendSrcAlpha: THREE.OneFactor,
        // 目标 alpha 因子 1
        blendDstAlpha: THREE.OneFactor,
      });
      // 用共享几何 + 槽位材质创建网格
      const mesh = new THREE.Mesh(geo, mat);
      // 关闭视锥剔除：实例位置在 shader 里算，包围盒不可信
      mesh.frustumCulled = false;
      // 初始不可见，等 update 时按 showRatio 打开
      mesh.visible = false;
      // 记录槽位
      this.meshArray.push(mesh);
      // 挂到人脸容器下
      this.container.add(mesh);
    }
  }

  /** 原站由点击/滑动驱动 faceIndex；这里做成定时自动轮换 + 平滑过渡 */
  advance(dt, showRatio) {
    // 计时器：累计到 5 秒就切下一位（原站是交互触发，这里自动播放）
    this._timer = (this._timer || 0) + dt;
    // 到达间隔：重置计时并把目标索引 +1
    if (this._timer > 5.0) {
      // 归零，开始下一轮
      this._timer = 0;
      // 目标索引递增（undefined 视作 0）
      this._target = (this._target || 0) + 1;
    }
    // 当前显示索引（浮点，用于在两位成员之间插值）
    this._index = this._index || 0;
    // 指数阻尼逼近目标：dt*8 使其约 0.12s 时间常数，避免切换过冲
    this._index += ((this._target || 0) - this._index) * Math.min(1, dt * 8);
    // 取整数部分决定「当前成员」槽位
    const base = Math.floor(this._index);
    // 当前成员 id（对 7 取模循环）
    const curr = TEAM_IDS[base % TEAM_IDS.length];
    // 下一位成员 id
    const next = TEAM_IDS[(base + 1) % TEAM_IDS.length];
    // 把索引小数部分作为过渡比例交给 update 做交叉溶解
    this.update(dt, showRatio, curr, next, this._index - base);
  }

  // 每帧更新：算点光源位置、切换纹理、分配两块网格的过渡状态
  update(dt, showRatio, currId, nextId, transition) {
    // 记录出场比例，供片元（通过 uniform）使用
    this.showRatio = showRatio;
    // 大于 0 即视为激活
    this.isActive = showRatio > 0;
    // 容器可见性跟随激活状态，彻底跳过渲染开销
    this.container.visible = this.isActive;
    // 写入着色器使用的出场比例
    this.sharedUniforms.u_showRatio.value = showRatio;
    // 未激活时提前返回，省掉后续矩阵与 uniform 计算
    if (!this.isActive) return;

    // 刷新世界矩阵：下面要用它的逆把鼠标射线点变换回容器局部空间
    this.container.updateMatrixWorld(true);
    // 复用向量 v
    const v = this._v;
    // 取 NDC 中心偏前一点（z=0.5）反投影成世界射线，再减去相机位置得到方向
    v.set(0, 0, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    // 沿射线走 75/v.z：v.z 是归一化方向的 z 分量，等效把方向投影到固定深度平面上
    v.multiplyScalar(75 / v.z).add(this.camera.position);
    // 容器世界矩阵的逆
    this._m.copy(this.container.matrixWorld).invert();
    // 世界点 → 容器局部空间（此时得到的是相对人像中心的偏移）
    v.applyMatrix4(this._m);
    // 取局部 y 偏移的 3%，限制在 ±0.05 弧度，作为俯仰角
    const ny = Math.min(0.05, Math.max(-0.05, v.y * 0.03));
    // 取局部 x 偏移的 3%，限制在 ±0.05 弧度，作为偏航角
    const nx = Math.min(0.05, Math.max(-0.05, v.x * 0.03));
    // 再变回世界空间：着色器需要的是世界坐标点光源
    v.applyMatrix4(this.container.matrixWorld);
    // 写进共享 uniform（两块网格共享同一个 Vector3 对象，一次赋值即可）
    this.sharedUniforms.u_mouse.value.copy(v);

    // 过渡进度简写
    const t = transition;
    // 槽位 A：当前成员（随 t 增大而退场）
    const a = this.meshArray[0];
    // 槽位 B：下一位成员（随 t 增大而进场）
    const b = this.meshArray[1];
    // 槽位 A 的 uniform 表
    const ua = a.material.uniforms;
    // A 显示 currId 的点云（成员未加载时给 null 兜底）
    ua.u_positionTexture.value = this.posTextures[currId] || null;
    // A 显示 currId 的法线/明暗
    ua.u_norShadeTexture.value = this.norTextures[currId] || null;
    // A 的激活动画比例 = 1-t：过渡越靠后越「收拢」
    ua.u_activeRatio.value = 1 - t;
    // 故障阈值由 activeRatio 映射到 0..0.9：越接近收拢，越容易触发抖动
    ua.u_glitchThreshold.value = fit(ua.u_activeRatio.value, 0.4, 1, 0, 0.9);
    // 再乘内部 activeRatio，做整体入场缓动
    ua.u_activeRatio.value *= this.activeRatio;
    // A 沿 -X 后撤 1.5×t，沿 -Z 后撤 2×t（近大远小制造纵深）
    a.position.set(t * -1.5, 0, -t * 2 - (1 - this.activeRatio) * 2);
    // A 的偏航 = 过渡偏转 + 鼠标偏航
    a.rotation.y = t * -0.3 + nx;
    // A 的俯仰 = 过渡偏转 + 鼠标俯仰
    a.rotation.x = t * 0.4 + ny;
    // A 可见
    a.visible = true;

    // 槽位 B 的 uniform 表
    const ub = b.material.uniforms;
    // B 显示 nextId 的点云
    ub.u_positionTexture.value = this.posTextures[nextId] || null;
    // B 显示 nextId 的法线/明暗
    ub.u_norShadeTexture.value = this.norTextures[nextId] || null;
    // B 的激活动画比例 = t：与 A 互补
    ub.u_activeRatio.value = t;
    // B 的故障阈值同样是 0..0.9 的映射
    ub.u_glitchThreshold.value = fit(ub.u_activeRatio.value, 0.4, 1, 0, 0.9);
    // 乘整体活动比例
    ub.u_activeRatio.value *= this.activeRatio;
    // B 从 +X 方向（t-1 为负）向中心靠拢，位置与 A 严格对称
    b.position.set((t - 1) * -1.5, 0, (t - 1) * 2 - (1 - this.activeRatio) * 2);
    // B 的偏航与 A 对称
    b.rotation.y = (t - 1) * -0.3 + nx;
    // B 的俯仰与 A 对称
    b.rotation.x = (t - 1) * 0.4 + ny;
    // B 可见
    b.visible = true;

    // 故障相位每帧随机 0..1000，让每次抖动形态都不同（原站同做法）
    this.sharedUniforms.u_glitchOffset.value = Math.random() * 1000;
    // 故障强度每帧随机 0..1，形成偶发的概率性抖动
    this.sharedUniforms.u_glitchStrength.value = Math.random();
  }

  // 释放人像层占用的 GPU 资源
  dispose() {
    // 所有位置纹理
    Object.values(this.posTextures).forEach((t) => t.dispose());
    // 所有法线/明暗纹理
    Object.values(this.norTextures).forEach((t) => t.dispose());
    // 两块网格：几何是共享的，材质各自独立，都释放
    this.meshArray.forEach((m) => {
      // 几何（两块网格共用同一份，重复 dispose 是幂等的）
      m.geometry.dispose();
      // 材质
      m.material.dispose();
    });
  }
}

// 线性区间映射 + 钳制：把 x∈[a,b] 映射到 [c,d]（a===b 时直接返回 c，防除零）
function fit(x, a, b, c, d) {
  // 归一化并钳到 0..1
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  // 线性插值输出
  return c + (d - c) * t;
}

// HUD 主体：地形等高线（terrain_lines.buf）+ 实例化字母层 + 离屏模糊合成
export class AboutHeroHud {
  constructor({ renderer, camera, shared, withChunks, fontTexture }) {
    // 主渲染器：离屏渲染 / 全屏 blit 都直接用它
    this.renderer = renderer;
    // 主相机：字母实例要以同一视角渲染，模糊后才和场景对齐
    this.camera = camera;
    // 全局共享 uniform（u_time / u_hudRatio 等）
    this.shared = shared;
    // chunk 注入函数
    this.chunk = withChunks;
    // 字体图集（横向 42 个字形），存进 shared.u_letterTexture 供字母材质使用
    this.fontTexture = fontTexture;
    // HUD 的世界空间容器，由主场景 add（线条与合成 quad 都挂这里）
    this.container = new THREE.Group();
    // 全屏 quad 专用场景：做 RT 之间的拷贝 / 模糊
    this._quadScene = new THREE.Scene();
    // 全屏 quad 本身（2×2 面片，顶点着色器直接输出裁剪空间坐标）
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    // 关闭视锥剔除：全屏 quad 不参与包围盒判断
    this._quad.frustumCulled = false;
    // 入场景
    this._quadScene.add(this._quad);
    // 可分离模糊材质：水平 / 垂直各跑一遍
    this._blurMat = new THREE.ShaderMaterial({
      // u_texture 每 pass 换，u_delta 是单步偏移
      uniforms: { u_texture: { value: null }, u_delta: { value: new THREE.Vector2() } },
      // 全屏顶点
      vertexShader: FULLSCREEN_VERT,
      // 9-tap 高斯片元
      fragmentShader: BLUR9_FRAG,
      // 纯后处理，不需要深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
    });
  }

  // 并行加载两份 buf，然后分别构建线条与字母
  async load() {
    // 两份地形/布局数据互不依赖，Promises.all 并行
    const [linesGeo, letterGeo] = await Promise.all([
      // 地形折线：每条等高线的顶点序列
      loadBuf('/assets/models/about/terrain_lines.buf'),
      // 字母摆放：每个实例的位置 + 密度
      loadBuf('/assets/models/about/letter_placements.buf'),
    ]);
    // 先把折线挤出成三角管
    this._buildLines(linesGeo);
    // 再构建实例字母层
    this._buildLetters(letterGeo);
  }

  /* ── 线条：沿折线生成 3 边管 ── */
  _buildLines(geo) {
    // 源数据：terrain_lines.buf 的顶点数组，每 3 个 float 一个路径点
    const t = geo.attributes.position.array;
    // 折线段数 = 阈值个数（每段一条独立折线）
    const lineCount = THRESHOLDS.length;
    // 源顶点总数
    const n = t.length / 3;
    // 挤出后位置数组：每个路径点扩成 SEGMENT_COUNT 个环点
    const pos = new Float32Array(n * SEGMENT_COUNT * 3);
    // 挤出后法线数组（环点在垂直于切线的截面上，沿环分布）
    const nor = new Float32Array(n * SEGMENT_COUNT * 3);
    // 顶点沿折线的累计弧长（着色器里的 t 属性，用于流动与显影）
    const tt = new Float32Array(n * SEGMENT_COUNT);
    // 每个顶点所属折线的总弧长
    const total = new Float32Array(n * SEGMENT_COUNT);
    // 每个顶点所属折线的序号（Uint8 足够，段数 < 256）
    const lineId = new Uint8Array(n * SEGMENT_COUNT);
    // 索引缓冲：每两个相邻环点之间生成 6 个索引 / 每边，段与段之间不连
    const index = new Uint16Array((n - lineCount) * 6 * SEGMENT_COUNT);

    // 复用：上一个路径点（段起点）
    const g = new THREE.Vector3();
    // 复用：当前路径点
    const v = new THREE.Vector3();
    // 复用：从数组读出的下一个路径点
    const cur = new THREE.Vector3();
    // 复用：切线方向
    const dir = new THREE.Vector3();
    // 复用：切线外的侧向（预留给双面法线，本实现用绕轴旋转代替）
    const side = new THREE.Vector3();
    // 世界 up，作为环起始法线
    const up = new THREE.Vector3(0, 1, 0);
    // 复用：当前环法线
    const ring = new THREE.Vector3();
    // 复用：环点旋转四元数（每步转 2π/3）
    const q = new THREE.Quaternion();
    // 复用：用于求两点距离的临时向量
    const v0 = new THREE.Vector3();
    // 顶点写指针（每写一个环点 +1）
    let w = 0;
    // 浮点数组写指针（pos / nor，每写一个环点 +3）
    let R = 0;
    // 索引写指针
    let E = 0;

    // 逐条折线挤出
    for (let k = 0; k < lineCount; k++) {
      // 本条折线的起始顶点下标
      const L = k === 0 ? 0 : THRESHOLDS[k - 1];
      // 本条折线的结束顶点下标（不含）
      const D = THRESHOLDS[k];
      // 读取起点
      cur.fromArray(t, L * 3);
      // v 记录「上一个已处理的点」，先置为起点
      v.copy(cur);
      // 本条折线的累计弧长（流场参数 t 的初值）
      let length = 0;
      // 遍历本条折线的每个路径点
      for (let z = L; z < D; z++) {
        // 源数组中的浮点偏移
        const j = z * 3;
        // g = 上一个点（本段的起点）
        g.copy(v);
        // 当前点定位到 v
        v.copy(cur);
        // 预读下一个点作为 cur（最后一点保持不动，避免越界）
        if (z < D - 1) cur.fromArray(t, j + 3);
        // 切线 = 下一点 - 上一点，归一化
        dir.subVectors(cur, g).normalize();
        // 侧向 = up × 切线（本实现最终用四元数旋转，这里保留原站计算步骤）
        side.crossVectors(up, dir).normalize();
        // 构造绕切线旋转 120° 的四元数：3 条边正好闭合一个三角形截面
        q.setFromAxisAngle(dir, (Math.PI * 2) / SEGMENT_COUNT);
        // 环的第一条法线从世界 up 开始
        ring.copy(up);
        // 累计弧长：加上「上一点 → 当前点」的距离
        length += v0.copy(v).sub(g).length();
        // 在截面上均匀分布 SEGMENT_COUNT 个环点
        for (let x = 0; x < SEGMENT_COUNT; x++) {
          // 依次旋转，得到下一条边的法线
          ring.applyQuaternion(q);
          // 位置：环点与路径点同位置（管径由法线方向 + 片段着色器控制，不做真实膨胀）
          pos[R] = v.x;
          // y
          pos[R + 1] = v.y;
          // z
          pos[R + 2] = v.z;
          // 法线 x
          nor[R] = ring.x;
          // 法线 y
          nor[R + 1] = ring.y;
          // 法线 z
          nor[R + 2] = ring.z;
          // 记录弧长
          tt[w] = length;
          // 记录折线编号
          lineId[w] = k;
          // 除最后一个路径点外都要连面
          if (z < D - 1) {
            // 环形索引回绕：最后一条边要连回第 0 条边
            const zz = x === SEGMENT_COUNT - 1 ? 1 - SEGMENT_COUNT : 1;
            // 第一个三角形：当前环点
            index[E++] = w;
            // 当前环点的下一条边
            index[E++] = w + zz;
            // 下一个环点
            index[E++] = w + SEGMENT_COUNT;
            // 第二个三角形：当前环点下一条边
            index[E++] = w + zz;
            // 下一个环点
            index[E++] = w + SEGMENT_COUNT;
            // 下一个环点的下一条边
            index[E++] = w + SEGMENT_COUNT + zz;
          }
          // 顶点指针前进
          w++;
          // 浮点指针前进 3
          R += 3;
        }
      }
      // 本条折线写出的顶点数（3 边 × 点数）
      const count = SEGMENT_COUNT * (D - L);
      // 回退指针到本条折线的起点，准备回填 totalLength
      w -= count;
      // 终点指针
      const end = w + count;
      // 把这条折线的总弧长写进每个顶点的 total 属性
      for (; w < end; w++) total[w] = length;
    }

    // 组装最终几何
    const g2 = new THREE.BufferGeometry();
    // 位置
    g2.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // 法线（管面朝向）
    g2.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    // 弧长（流动参数）
    g2.setAttribute('t', new THREE.BufferAttribute(tt, 1));
    // 总长（用于 mod 循环与按比例显影）
    g2.setAttribute('totalLength', new THREE.BufferAttribute(total, 1));
    // 折线编号
    g2.setAttribute('lineId', new THREE.BufferAttribute(lineId, 1));
    // 索引
    g2.setIndex(new THREE.BufferAttribute(index, 1));

    // 线条网格：单一材质，所有折线一次画完
    this.lineMesh = new THREE.Mesh(
      g2,
      new THREE.ShaderMaterial({
        // 需要 u_time / u_hudRatio，直接复用全局 shared（同一对象，主循环改一处即可）
        uniforms: { ...this.shared },
        // 线条顶点（chunk 已内联，无 #include 需求，故不加 withChunks）
        vertexShader: LINE_VERT,
        // 线条片元
        fragmentShader: LINE_FRAG,
        // 自定义混合：用 Max 取较亮值，避免加法叠加过曝
        blending: THREE.CustomBlending,
        // 颜色取最大值（原站 Lines 用 MaxEquation）
        blendEquation: THREE.MaxEquation,
        // 源因子 1
        blendSrc: THREE.OneFactor,
        // 目标因子 1
        blendDst: THREE.OneFactor,
        // alpha 走普通加法
        blendEquationAlpha: THREE.AddEquation,
        // alpha 源因子 1
        blendSrcAlpha: THREE.OneFactor,
        // alpha 目标因子 1
        blendDstAlpha: THREE.OneFactor,
      })
    );
    // 渲染顺序 15：在粒子（5）之后、雾片（20）之前
    this.lineMesh.renderOrder = 15;
    // 顶点位置在 shader 内被 z 偏移，包围盒不可信
    this.lineMesh.frustumCulled = false;
    // 挂到 HUD 容器
    this.container.add(this.lineMesh);
  }

  /* ── 字母：4 组实例，离屏 + 逐级模糊 + 全屏加法 ── */
  _buildLetters(geo) {
    // 单位面片：先上移 0.5 让锚点在底边，再绕 Y 转 180° 朝向相机
    const plane = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateY(Math.PI);
    // 布局数据里的实例总数
    const count = geo.attributes.position.count;
    // 平均切成 4 组（原站 4 个逐级模糊的层，每组密度/速度不同）
    const per = Math.floor(count / 4);
    // 实例位置数组（每 3 个 float 一组）
    const srcPos = geo.attributes.position.array;
    // 实例密度数组（影响透明度）
    const srcDensity = geo.attributes.density.array;

    // 字母材质（4 组共用；实例属性才区分层次）
    this.letterMat = new THREE.ShaderMaterial({
      // 全局 shared + 字体图集（u_letterTexture 已存在于 shared 中，这里显式再指一次）
      uniforms: { ...this.shared, u_letterTexture: this.shared.u_letterTexture },
      // 顶点：字条滚动 + 逐实例随机速度
      vertexShader: this.chunk(LETTER_VERT),
      // 片元：图集取样 + 乱码跳字
      fragmentShader: LETTER_FRAG,
      // 离屏层不参与深度
      depthTest: false,
      // 不写深度
      depthWrite: false,
      // 透明
      transparent: true,
      // 自定义混合：纯加法
      blending: THREE.CustomBlending,
      // 加法
      blendEquation: THREE.AddEquation,
      // 源 1
      blendSrc: THREE.OneFactor,
      // 目标 1
      blendDst: THREE.OneFactor,
      // alpha 也做加法
      blendEquationAlpha: THREE.AddEquation,
      // alpha 源 1
      blendSrcAlpha: THREE.OneFactor,
      // alpha 目标 1
      blendDstAlpha: THREE.OneFactor,
    });

    // 4 组网格（分别渲染后再逐级模糊，形成远近层次）
    this.letterMeshes = [];
    // 逐组构建实例化几何
    for (let g = 0; g < 4; g++) {
      // 每组独立几何：实例属性必须分开
      const ig = new THREE.InstancedBufferGeometry();
      // 面片基础属性
      for (const [k, val] of Object.entries(plane.attributes)) ig.setAttribute(k, val);
      // 索引
      ig.setIndex(plane.index);
      // 每组实例随机数（4 个分量，驱动滚动速度/闪变/明暗）
      const rands = new Float32Array(count * 4);
      // 只填本组用到的 per 个实例（其余留给其它组按偏移取用）
      for (let i = 0; i < per; i++) {
        // 分量 0：滚动速度
        rands[i * 4] = Math.random();
        // 分量 1：字条字符数（50~100）
        rands[i * 4 + 1] = Math.random();
        // 分量 2：亮度系数
        rands[i * 4 + 2] = Math.random();
        // 分量 3：乱码种子
        rands[i * 4 + 3] = Math.random();
      }
      // 注册实例随机数
      ig.setAttribute('instanceRands', new THREE.InstancedBufferAttribute(rands, 4));
      // 本组在总实例数组中的起始下标
      const from = per * g;
      // 本组实例位置（切片保证每组拿自己的那一段）
      ig.setAttribute('instancePos', new THREE.InstancedBufferAttribute(srcPos.slice(from * 3, (from + per) * 3), 3));
      // 本组实例密度（影响 v_opacity）
      ig.setAttribute('instanceDensity', new THREE.InstancedBufferAttribute(srcDensity.slice(from, from + per), 1));
      // 用共享材质创建网格并记录
      this.letterMeshes.push(new THREE.Mesh(ig, this.letterMat));
    }

    // 字母专用离屏场景（每组渲染一次后立刻移除，避免互相叠加）
    this.letterScene = new THREE.Scene();
    // 主离屏 RT：字母叠加结果（1×1 起步，渲染时按画布尺寸 resize）
    this.rt = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    // 模糊中转 RT：水平模糊写到这，再垂直模糊写回 rt
    this.blurRt = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });

    // 全屏合成 quad：把 rt 以加法混合叠回主场景
    this.quadMesh = new THREE.Mesh(
      // 2×2 面片覆盖裁剪空间
      new THREE.PlaneGeometry(2, 2),
      // 合成材质
      new THREE.ShaderMaterial({
        // 采样离屏结果
        uniforms: { u_texture: { value: this.rt.texture } },
        // 全屏顶点
        vertexShader: FULLSCREEN_VERT,
        // 片元内联：直接采样并输出（叠加交给混合状态）
        fragmentShader: 'varying vec2 v_uv; uniform sampler2D u_texture; void main() { gl_FragColor = texture2D(u_texture, v_uv); }',
        // 不需要深度
        depthTest: false,
        // 不写深度
        depthWrite: false,
        // 透明
        transparent: true,
        // 自定义混合：加法
        blending: THREE.CustomBlending,
        // 加法
        blendEquation: THREE.AddEquation,
        // 源 1
        blendSrc: THREE.OneFactor,
        // 目标 1
        blendDst: THREE.OneFactor,
        // alpha 加法
        blendEquationAlpha: THREE.AddEquation,
        // alpha 源 1
        blendSrcAlpha: THREE.OneFactor,
        // alpha 目标 1
        blendDstAlpha: THREE.OneFactor,
      })
    );
    // 渲染顺序 10：在场景主体之后、线条（15）之前
    this.quadMesh.renderOrder = 10;
    // 全屏 quad 不剔
    this.quadMesh.frustumCulled = false;
    // 关键：每次绘制前先把 4 组字母渲染到 rt（离屏 → 模糊），再采样
    this.quadMesh.onBeforeRender = () => this._renderLetters();
    // 挂进 HUD 容器
    this.container.add(this.quadMesh);
  }

  // 全屏 blit：换材质后渲染到指定 RT（target 为 null 时回屏幕）
  _blit(material, target) {
    // 给共享全屏 quad 换材质
    this._quad.material = material;
    // 绑定目标
    this.renderer.setRenderTarget(target);
    // 用全屏场景 + 主相机绘制（顶点着色器忽略相机，只求覆盖全屏）
    this.renderer.render(this._quadScene, this.camera);
  }

  // 一次可分离模糊：水平写 tmp，再垂直写回 rt（rt 尺寸减半以节省带宽）
  _blur(radius, rt, tmp) {
    // 半分辨率宽度
    const w = Math.ceil(rt.width * 0.5);
    // 半分辨率高度
    const h = Math.ceil(rt.height * 0.5);
    // 尺寸变化时才 resize，避免每帧重建 FBO
    if (tmp.width !== w || tmp.height !== h) tmp.setSize(w, h);
    // 模糊材质的 uniform 简写
    const b = this._blurMat.uniforms;
    // 输入源
    b.u_texture.value = rt.texture;
    // 水平步长：radius 个像素换算成 uv，再按 0.25 收缩到实际需要的高斯核宽度
    b.u_delta.value.set(radius / w * 0.25, 0);
    // 水平模糊 → tmp
    this._blit(this._blurMat, tmp);
    // 输入换成水平结果
    b.u_texture.value = tmp.texture;
    // 垂直步长
    b.u_delta.value.set(0, radius / h * 0.25);
    // 垂直模糊 → 回到 rt（原地覆盖，省一张 RT）
    this._blit(this._blurMat, rt);
  }

  // 离屏渲染 4 组字母，并逐级模糊（16/8/4）
  _renderLetters() {
    // 渲染器简写
    const r = this.renderer;
    // 当前绘制缓冲宽度（物理像素）
    const W = r.domElement.width;
    // 高度
    const H = r.domElement.height;
    // 尺寸不匹配就重建 RT（1×1 起步，首次绘制时同步到画布尺寸）
    if (this.rt.width !== W || this.rt.height !== H) this.rt.setSize(W, H);

    // 保存调用前的渲染目标，结束时还原，避免打断主场景渲染
    const prev = r.getRenderTarget();
    // 保存清屏色
    const prevColor = r.getClearColor(new THREE.Color());
    // 保存清屏 alpha
    const prevAlpha = r.getClearAlpha();
    // 切到字母 RT
    r.setRenderTarget(this.rt);
    // 透明黑，等价于「清空为无字」
    r.setClearColor(0x000000, 0);
    // 只清颜色（不碰深度/模板）
    r.clear(true, false, false);

    // 逐级模糊半径：第 1 组最大、之后递减，形成 4 层景深
    const radii = [16, 8, 4];
    // 逐组绘制
    for (let i = 0; i < this.letterMeshes.length; i++) {
      // 临时加入离屏场景（场景里一次只有一组，避免组间叠加）
      this.letterScene.add(this.letterMeshes[i]);
      // 渲染这一组，结果累加到 rt
      r.render(this.letterScene, this.camera);
      // 立刻移除，保持场景干净
      this.letterScene.remove(this.letterMeshes[i]);
      // 前 3 组渲染后做一次模糊（第 4 组保持清晰，作为最近层）
      if (i < 3) this._blur(radii[i], this.rt, this.blurRt);
    }

    // 还原渲染目标
    r.setRenderTarget(prev);
    // 还原清屏色
    r.setClearColor(prevColor, prevAlpha);
    // 把最终 RT 绑给合成 quad（rt 可能被 _blur 原地覆盖，纹理句柄不变，这里保持一致）
    this.quadMesh.material.uniforms.u_texture.value = this.rt.texture;
  }

  // 无每帧逻辑：所有动画都由共享 uniform（u_time / u_hudRatio）驱动，保持接口对齐
  update() {}

  // 释放 HUD 的全部 GPU 资源
  dispose() {
    // 线条几何
    this.lineMesh?.geometry.dispose();
    // 线条材质
    this.lineMesh?.material.dispose();
    // 4 组字母几何
    this.letterMeshes?.forEach((m) => m.geometry.dispose());
    // 字母共享材质
    this.letterMat?.dispose();
    // 字母离屏 RT
    this.rt?.dispose();
    // 模糊中转 RT
    this.blurRt?.dispose();
    // 模糊材质
    this._blurMat?.dispose();
    // 合成 quad 几何
    this.quadMesh?.geometry.dispose();
    // 合成 quad 材质
    this.quadMesh?.material.dispose();
    // 全屏 blit quad 几何
    this._quad.geometry.dispose();
  }
}
