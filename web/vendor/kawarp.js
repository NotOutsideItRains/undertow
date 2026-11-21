var c=Object.freeze({warpIntensity:1,blurPasses:8,saturation:1.5,tintColor:Object.freeze([.157,.157,.235]),tintIntensity:.15,dithering:.008}),f=(h,e,i)=>Math.max(e,Math.min(i,h)),g={warpIntensity:h=>f(h,0,1),blurPasses:h=>f(Math.floor(h),0,40),saturation:h=>f(h,0,3),tintColor:h=>[f(h[0],0,1),f(h[1],0,1),f(h[2],0,1)],tintIntensity:h=>f(h,0,1),dithering:h=>f(h,0,.1)};var x={sampleWidth:128,sampleHeight:72,downsampleFactor:2,frameRate:0,smoothing:0},b=.25,S=8,_=(h,e,i,t)=>typeof h=="number"&&Number.isFinite(h)?Math.min(t,Math.max(i,h)):e,E=h=>"naturalWidth"in h?[h.naturalWidth,h.naturalHeight]:"videoWidth"in h?[h.videoWidth,h.videoHeight]:"displayWidth"in h?[h.displayWidth,h.displayHeight]:[h.width,h.height],p=`
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`,R=`
  precision highp float;
  uniform sampler2D u_texture;
  uniform vec2 u_resolution;
  uniform float u_offset;
  varying vec2 v_texCoord;

  void main() {
    highp vec2 texelSize = 1.0 / u_resolution;
    highp vec4 color = vec4(0.0);

    color += texture2D(u_texture, v_texCoord + vec2(-u_offset, -u_offset) * texelSize);
    color += texture2D(u_texture, v_texCoord + vec2(u_offset, -u_offset) * texelSize);
    color += texture2D(u_texture, v_texCoord + vec2(-u_offset, u_offset) * texelSize);
    color += texture2D(u_texture, v_texCoord + vec2(u_offset, u_offset) * texelSize);

    gl_FragColor = color * 0.25;
  }
`,A=`
  precision highp float;
  uniform sampler2D u_texture1;
  uniform sampler2D u_texture2;
  uniform float u_blend;
  varying vec2 v_texCoord;

  void main() {
    vec4 color1 = texture2D(u_texture1, v_texCoord);
    vec4 color2 = texture2D(u_texture2, v_texCoord);
    gl_FragColor = mix(color1, color2, u_blend);
  }
`,P=`
  precision highp float;
  uniform sampler2D u_texture;
  uniform vec3 u_tintColor;
  uniform float u_tintIntensity;
  varying vec2 v_texCoord;

  void main() {
    vec4 color = texture2D(u_texture, v_texCoord);
    float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));

    // darkMask: 1.0 for black, 0.0 for luma >= 0.5
    float darkMask = 1.0 - smoothstep(0.0, 0.5, luma);

    // Blend dark areas toward tint color
    color.rgb = mix(color.rgb, u_tintColor, darkMask * u_tintIntensity);

    gl_FragColor = color;
  }
`,I=`
  precision highp float;
  uniform sampler2D u_texture;
  uniform float u_time;
  uniform float u_intensity;
  varying vec2 v_texCoord;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                        -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void main() {
    vec2 uv = v_texCoord;
    float t = u_time * 0.05;

    vec2 center = uv - 0.5;
    float centerWeight = 1.0 - smoothstep(0.0, 0.7, length(center));

    // Large-scale movement (slow, big blobs)
    float n1 = snoise(uv * 0.35 + vec2(t, t * 0.7));
    float n2 = snoise(uv * 0.35 + vec2(-t * 0.8, t * 0.5) + vec2(50.0, 50.0));

    // Medium-scale detail (adds organic movement)
    float n3 = snoise(uv * 0.9 + vec2(t * 1.2, -t) + vec2(100.0, 0.0));
    float n4 = snoise(uv * 0.9 + vec2(-t, t * 1.1) + vec2(0.0, 100.0));

    // Combine two octaves
    vec2 warp = vec2(
      n1 * 0.65 + n3 * 0.35,
      n2 * 0.65 + n4 * 0.35
    ) * centerWeight;

    vec2 warpedUV = uv + warp * u_intensity;
    warpedUV = clamp(warpedUV, 0.0, 1.0);

    gl_FragColor = texture2D(u_texture, warpedUV);
  }
`,w=`
  precision highp float;
  uniform sampler2D u_texture;
  uniform float u_saturation;
  uniform float u_dithering;
  uniform float u_time;
  uniform float u_scale;
  uniform vec2 u_resolution;
  varying vec2 v_texCoord;

  highp float hash(highp vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    vec2 uv = (v_texCoord - 0.5) / u_scale + 0.5;
    uv = clamp(uv, 0.0, 1.0);

    vec4 color = texture2D(u_texture, uv);

    vec2 center = v_texCoord - 0.5;
    float vignette = 1.0 - dot(center, center) * 0.3;
    color.rgb *= vignette;

    float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
    color.rgb = mix(vec3(gray), color.rgb, u_saturation);

    highp vec2 pixelPos = floor(v_texCoord * u_resolution);
    highp float noise = hash(vec3(pixelPos, floor(u_time * 60.0)));
    color.rgb += (noise - 0.5) * u_dithering;

    gl_FragColor = color;
  }
`,y=`
  precision highp float;
  uniform sampler2D u_texture;
  uniform vec2 u_texelSize;
  varying vec2 v_texCoord;

  void main() {
    vec2 offset = u_texelSize * 0.25;
    gl_FragColor = 0.25 * (
      texture2D(u_texture, v_texCoord + vec2(-offset.x, -offset.y)) +
      texture2D(u_texture, v_texCoord + vec2(offset.x, -offset.y)) +
      texture2D(u_texture, v_texCoord + vec2(-offset.x, offset.y)) +
      texture2D(u_texture, v_texCoord + vec2(offset.x, offset.y))
    );
  }
`,B=`
  precision highp float;
  uniform sampler2D u_texture;
  uniform sampler2D u_history;
  uniform float u_response;
  uniform float u_minStep;
  varying vec2 v_texCoord;

  void main() {
    vec4 history = texture2D(u_history, v_texCoord);
    vec4 current = texture2D(u_texture, v_texCoord);
    vec4 blended = mix(history, current, u_response);
    vec4 remaining = current - history;
    vec4 minimal = history + sign(remaining) * min(abs(remaining), vec4(u_minStep));
    gl_FragColor = mix(
      minimal,
      blended,
      step(abs(minimal - history), abs(blended - history))
    );
  }
`,F=class{canvas;gl;halfFloatExt=null;halfFloatLinearExt=null;blurProgram;blendProgram;tintProgram;warpProgram;outputProgram;positionBuffer;texCoordBuffer;sourceTexture;blurFBO1;blurFBO2;currentAlbumFBO;nextAlbumFBO;warpFBO;animationId=null;lastFrameTime=0;accumulatedTime=0;isPlaying=!1;disposed=!1;isTransitioning=!1;transitionStartTime=0;_transitionDuration;_warpIntensity;_blurPasses;_animationSpeed;_targetAnimationSpeed;_saturation;_tintColor;_tintIntensity;_dithering;_scale;hasImage=!1;gl2;halfFloatRenderTargets=!1;float32RenderTargets=!1;floatLinearFiltering=!1;_highPrecisionOutput=!1;highPrecisionInputRequested;activeSourceTexture;imageSourceWidth=0;imageSourceHeight=0;videoFrameWidth=0;videoFrameHeight=0;video=null;videoLoadCount=0;shownVideoLoad=0;videoOptions={...x};videoCallbackId=null;videoUploadTexture=null;videoStages=[];videoHistory=[];videoHistoryIndex=0;hasVideoHistory=!1;videoSmoothingTarget=null;videoSmoothingTargetAt=0;videoSmoothedAt=0;videoHistoryStep=0;videoSampleSlot=Number.NEGATIVE_INFINITY;videoTargetsStale=!0;videoSourceWidth=0;videoSourceHeight=0;videoFrameTime=0;videoMediaTime=0;videoFrameShown=!1;videoFramePending=!1;retainedVideoFrame=null;samplingPrograms=null;sampleTargets=[];sampleTargetsLayout=[0,0,0];pendingSampleSize=0;samplePixelBuffer=null;pendingSample=null;attribs;uniforms;constructor(e,i={}){this.canvas=e;let t={alpha:!0,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!0,powerPreference:"high-performance"},r=i.highPrecisionInput||i.highPrecisionOutput?e.getContext("webgl2",t):null,s=r??e.getContext("webgl",t);if(!s)throw new Error("WebGL not supported");this.gl=s,this.gl2=r,this.highPrecisionInputRequested=!!r&&!!i.highPrecisionInput,this.halfFloatExt=s.getExtension("OES_texture_half_float"),this.halfFloatLinearExt=s.getExtension("OES_texture_half_float_linear"),r&&(this.float32RenderTargets=!!r.getExtension("EXT_color_buffer_float"),this.halfFloatRenderTargets=this.float32RenderTargets||!!r.getExtension("EXT_color_buffer_half_float"),this.floatLinearFiltering=!!r.getExtension("OES_texture_float_linear")),this._warpIntensity=i.warpIntensity??c.warpIntensity,this._blurPasses=i.blurPasses??c.blurPasses,this._animationSpeed=i.animationSpeed??1,this._targetAnimationSpeed=this._animationSpeed,this._transitionDuration=i.transitionDuration??1e3,this._saturation=i.saturation??c.saturation,this._tintColor=[...i.tintColor??c.tintColor],this._tintIntensity=i.tintIntensity??c.tintIntensity,this._dithering=i.dithering??c.dithering,this._scale=i.scale??1,this.blurProgram=this.createProgram(p,R),this.blendProgram=this.createProgram(p,A),this.tintProgram=this.createProgram(p,P),this.warpProgram=this.createProgram(p,I),this.outputProgram=this.createProgram(p,w),this.attribs={position:s.getAttribLocation(this.blurProgram,"a_position"),texCoord:s.getAttribLocation(this.blurProgram,"a_texCoord")},this.uniforms={blur:{resolution:s.getUniformLocation(this.blurProgram,"u_resolution"),texture:s.getUniformLocation(this.blurProgram,"u_texture"),offset:s.getUniformLocation(this.blurProgram,"u_offset")},blend:{texture1:s.getUniformLocation(this.blendProgram,"u_texture1"),texture2:s.getUniformLocation(this.blendProgram,"u_texture2"),blend:s.getUniformLocation(this.blendProgram,"u_blend")},warp:{texture:s.getUniformLocation(this.warpProgram,"u_texture"),time:s.getUniformLocation(this.warpProgram,"u_time"),intensity:s.getUniformLocation(this.warpProgram,"u_intensity")},tint:{texture:s.getUniformLocation(this.tintProgram,"u_texture"),tintColor:s.getUniformLocation(this.tintProgram,"u_tintColor"),tintIntensity:s.getUniformLocation(this.tintProgram,"u_tintIntensity")},output:{texture:s.getUniformLocation(this.outputProgram,"u_texture"),saturation:s.getUniformLocation(this.outputProgram,"u_saturation"),dithering:s.getUniformLocation(this.outputProgram,"u_dithering"),time:s.getUniformLocation(this.outputProgram,"u_time"),scale:s.getUniformLocation(this.outputProgram,"u_scale"),resolution:s.getUniformLocation(this.outputProgram,"u_resolution")}},this.positionBuffer=this.createBuffer(new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1])),this.texCoordBuffer=this.createBuffer(new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1])),this.sourceTexture=this.createTexture(),this.activeSourceTexture=this.sourceTexture,this.blurFBO1=this.createFramebuffer(128,128,!0),this.blurFBO2=this.createFramebuffer(128,128,!0),this.currentAlbumFBO=this.createFramebuffer(128,128,!0),this.nextAlbumFBO=this.createFramebuffer(128,128,!0);let a=Math.max(1,e.width||640),n=Math.max(1,e.height||360);this.warpFBO=this.createFramebuffer(a,n,!0),i.highPrecisionOutput&&this.applyFloatDrawingBuffer()}get highPrecisionOutput(){return this._highPrecisionOutput}get highPrecisionInput(){return this.highPrecisionInputRequested&&this.float32RenderTargets}get warpIntensity(){return this._warpIntensity}set warpIntensity(e){this._warpIntensity=g.warpIntensity(e)}get blurPasses(){return this._blurPasses}set blurPasses(e){let i=g.blurPasses(e);i!==this._blurPasses&&(this._blurPasses=i,this.hasImage&&this.reblurCurrentImage())}get animationSpeed(){return this._targetAnimationSpeed}set animationSpeed(e){this._targetAnimationSpeed=Math.max(0,Math.min(16,e))}get transitionDuration(){return this._transitionDuration}set transitionDuration(e){this._transitionDuration=Math.max(0,Math.min(5e3,e))}get saturation(){return this._saturation}set saturation(e){this._saturation=g.saturation(e)}get tintColor(){return this._tintColor}set tintColor(e){let i=g.tintColor(e);i.some((r,s)=>r!==this._tintColor[s])&&(this._tintColor=i,this.hasImage&&this.reblurCurrentImage())}get tintIntensity(){return this._tintIntensity}set tintIntensity(e){let i=g.tintIntensity(e);i!==this._tintIntensity&&(this._tintIntensity=i,this.hasImage&&this.reblurCurrentImage())}get dithering(){return this._dithering}set dithering(e){this._dithering=g.dithering(e)}get scale(){return this._scale}set scale(e){this._scale=Math.max(.01,Math.min(4,e))}setOptions(e){e.warpIntensity!==void 0&&(this.warpIntensity=e.warpIntensity),e.blurPasses!==void 0&&(this.blurPasses=e.blurPasses),e.animationSpeed!==void 0&&(this.animationSpeed=e.animationSpeed),e.transitionDuration!==void 0&&(this.transitionDuration=e.transitionDuration),e.saturation!==void 0&&(this.saturation=e.saturation),e.tintColor!==void 0&&(this.tintColor=e.tintColor),e.tintIntensity!==void 0&&(this.tintIntensity=e.tintIntensity),e.dithering!==void 0&&(this.dithering=e.dithering),e.scale!==void 0&&(this.scale=e.scale)}getOptions(){return{warpIntensity:this._warpIntensity,blurPasses:this._blurPasses,animationSpeed:this._targetAnimationSpeed,transitionDuration:this._transitionDuration,saturation:this._saturation,tintColor:this._tintColor,tintIntensity:this._tintIntensity,dithering:this._dithering,scale:this._scale}}async loadImage(e){if(!e)return;let i=this.videoLoadCount,t=null;try{let a=await fetch(e,{mode:"cors"});if(a.ok){let n=await a.blob();t=await createImageBitmap(n)}}catch{}if(t||(t=await new Promise((a,n)=>{let o=new Image;o.crossOrigin="anonymous",o.onload=()=>a(o),o.onerror=()=>n(new Error(`Failed to load image: ${e}`)),o.src=e})),this.disposed||this.shownVideoLoad>i){"close"in t&&t.close();return}let r=!!this.video&&this.videoLoadCount!==i,s=this.gl;s.bindTexture(s.TEXTURE_2D,this.sourceTexture),s.pixelStorei(s.UNPACK_FLIP_Y_WEBGL,0),s.texImage2D(s.TEXTURE_2D,0,s.RGBA,s.RGBA,s.UNSIGNED_BYTE,t),[this.imageSourceWidth,this.imageSourceHeight]=E(t),"close"in t&&typeof t.close=="function"&&t.close(),this.processNewImage(this.sourceTexture,r)}loadImageElement(e){this.showImageElement(e,!1)}showImageElement(e,i){this.gl.bindTexture(this.gl.TEXTURE_2D,this.sourceTexture),this.gl.texImage2D(this.gl.TEXTURE_2D,0,this.gl.RGBA,this.gl.RGBA,this.gl.UNSIGNED_BYTE,e),[this.imageSourceWidth,this.imageSourceHeight]=E(e),this.processNewImage(this.sourceTexture,i)}loadImageData(e,i,t){this.gl.bindTexture(this.gl.TEXTURE_2D,this.sourceTexture),this.gl.texImage2D(this.gl.TEXTURE_2D,0,this.gl.RGBA,i,t,0,this.gl.RGBA,this.gl.UNSIGNED_BYTE,e instanceof Uint8ClampedArray?new Uint8Array(e.buffer):e),this.imageSourceWidth=i,this.imageSourceHeight=t,this.processNewImage()}loadFromImageData(e){this.loadImageData(e.data,e.width,e.height)}async loadBlob(e){let i=this.videoLoadCount,t=await createImageBitmap(e);if(this.disposed||this.shownVideoLoad>i){t.close();return}let r=!!this.video&&this.videoLoadCount!==i;this.showImageElement(t,r),t.close()}loadBase64(e){let i=e.startsWith("data:")?e:`data:image/png;base64,${e}`;return this.loadImage(i)}async loadArrayBuffer(e,i="image/png"){let t=new Blob([e],{type:i});return this.loadBlob(t)}loadGradient(e,i=135){let r=document.createElement("canvas");r.width=512,r.height=512;let s=r.getContext("2d");if(!s)return;let a=i*Math.PI/180,n=512/2-Math.cos(a)*512,o=512/2-Math.sin(a)*512,d=512/2+Math.cos(a)*512,u=512/2+Math.sin(a)*512,m=s.createLinearGradient(n,o,d,u);e.forEach((T,v)=>{m.addColorStop(v/(e.length-1),T)}),s.fillStyle=m,s.fillRect(0,0,512,512),this.loadImageElement(r)}loadVideo(e,i={}){if(this.disposed)return;if(typeof e.requestVideoFrameCallback!="function")throw new Error("Video sources require requestVideoFrameCallback");let t=this.video!==e;t&&(this.videoLoadCount++,this.unloadVideo(),this.video=e,this.videoFrameShown=!1,this.hasVideoHistory=!1,this.videoSampleSlot=Number.NEGATIVE_INFINITY);let r={sampleWidth:Math.round(_(i.sampleWidth,x.sampleWidth,1,1024)),sampleHeight:Math.round(_(i.sampleHeight,x.sampleHeight,1,1024)),downsampleFactor:_(i.downsampleFactor,x.downsampleFactor,1.25,4),frameRate:_(i.frameRate,x.frameRate,0,240),smoothing:_(i.smoothing,x.smoothing,0,1e4),onError:i.onError},s=this.videoOptions;(t||r.sampleWidth!==s.sampleWidth||r.sampleHeight!==s.sampleHeight||r.downsampleFactor!==s.downsampleFactor||r.smoothing>0!=s.smoothing>0)&&(this.videoTargetsStale=!0),this.videoOptions=r,this.requestVideoFrame(),e.readyState>=e.HAVE_CURRENT_DATA&&(t||e.paused&&this.videoTargetsStale)&&this.processVideoFrame(performance.now(),e.currentTime)}unloadVideo(){let e=this.video;e&&(this.videoCallbackId!==null&&(e.cancelVideoFrameCallback(this.videoCallbackId),this.videoCallbackId=null),e.removeEventListener("pause",this.resumeVideoCallbacks),this.video=null,this.videoFramePending=!1,this.releaseVideoTargets(),this.videoUploadTexture&&(this.gl.deleteTexture(this.videoUploadTexture),this.videoUploadTexture=null))}sampleSource(e=32){if(this.disposed||!this.hasImage)return Promise.resolve(null);let i=Math.round(_(e,32,1,128));if(this.pendingSample)return this.pendingSampleSize===i?this.pendingSample:this.pendingSample.then(()=>this.sampleSource(i));let t=this.gl,[r,s]=this.activeSourceTexture===this.sourceTexture?[this.imageSourceWidth,this.imageSourceHeight]:[this.videoFrameWidth,this.videoFrameHeight];this.prepareSampleTargets(r,s,i);let a=this.activeSourceTexture;for(let m of this.sampleTargets)this.drawDownsample(a,m),a=m.texture;let n=new Uint8Array(i*i*4),o=this.gl2;if(!o)return t.readPixels(0,0,i,i,t.RGBA,t.UNSIGNED_BYTE,n),Promise.resolve(n);this.samplePixelBuffer??=o.createBuffer(),o.bindBuffer(o.PIXEL_PACK_BUFFER,this.samplePixelBuffer),o.bufferData(o.PIXEL_PACK_BUFFER,n.byteLength,o.STREAM_READ),o.readPixels(0,0,i,i,o.RGBA,o.UNSIGNED_BYTE,0),o.bindBuffer(o.PIXEL_PACK_BUFFER,null);let d=o.fenceSync(o.SYNC_GPU_COMMANDS_COMPLETE,0);if(!d)return Promise.resolve(null);o.flush();let u=new Promise(m=>{let T=()=>{if(this.disposed){o.deleteSync(d),m(null);return}let v=o.clientWaitSync(d,0,0);if(v===o.TIMEOUT_EXPIRED){setTimeout(T,4);return}if(o.deleteSync(d),v===o.WAIT_FAILED){m(null);return}o.bindBuffer(o.PIXEL_PACK_BUFFER,this.samplePixelBuffer),o.getBufferSubData(o.PIXEL_PACK_BUFFER,0,n),o.bindBuffer(o.PIXEL_PACK_BUFFER,null),m(n)};setTimeout(T,0)}).finally(()=>{this.pendingSample=null});return this.pendingSample=u,this.pendingSampleSize=i,u}prepareSampleTargets(e,i,t){let[r,s,a]=this.sampleTargetsLayout;if(e===r&&i===s&&t===a)return;for(let d of this.sampleTargets)this.deleteFramebuffer(d);this.sampleTargets=[];let n=e,o=i;for(;n>t*2||o>t*2;)n=Math.max(t,Math.ceil(n/2)),o=Math.max(t,Math.ceil(o/2)),this.sampleTargets.push(this.createByteFramebuffer(n,o));this.sampleTargets.push(this.createByteFramebuffer(t,t)),this.sampleTargetsLayout=[e,i,t]}createByteFramebuffer(e,i){return this.gl2?this.createSizedFramebuffer(e,i,this.gl2.RGBA8):this.createFramebuffer(e,i)}requestVideoFrame(){!this.video||this.videoCallbackId!==null||(this.videoCallbackId=this.video.requestVideoFrameCallback(this.handleVideoFrame))}handleVideoFrame=(e,i)=>{this.videoCallbackId=null;let t=this.video;if(!t||this.disposed)return;if(!this.isPlaying&&!t.paused){this.videoFramePending=!0,t.addEventListener("pause",this.resumeVideoCallbacks,{once:!0});return}this.requestVideoFrame();let{frameRate:r}=this.videoOptions;if(r>0&&!t.paused){let s=1e3/r;if(e<this.videoSampleSlot+s*.75)return}this.processVideoFrame(e,i.mediaTime)};resumeVideoCallbacks=()=>{this.requestVideoFrame()};processVideoFrame(e,i){let t=this.video;if(!t||t.readyState<t.HAVE_CURRENT_DATA||t.videoWidth===0||t.videoHeight===0)return;let r=this.gl,s=e-this.videoFrameTime;try{this.prepareVideoTargets(t.videoWidth,t.videoHeight),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,this.videoUploadTexture),r.pixelStorei(r.UNPACK_FLIP_Y_WEBGL,!0),r.texImage2D(r.TEXTURE_2D,0,r.RGBA,r.RGBA,r.UNSIGNED_BYTE,t)}catch(u){let{onError:m}=this.videoOptions;this.unloadVideo(),m?.(u);return}finally{r.pixelStorei(r.UNPACK_FLIP_Y_WEBGL,!1)}let a=this.videoUploadTexture;for(let u of this.videoStages)this.drawDownsample(a,u),a=u.texture;let{smoothing:n}=this.videoOptions,o=!1;if(n>0){let u=s/1e3*t.playbackRate,m=Math.abs(i-this.videoMediaTime-u)>b;!this.hasVideoHistory||!this.videoFrameShown||!this.isPlaying||t.paused||m?(a=this.drawSmoothing(a,1),this.videoSmoothingTarget=null):(this.videoSmoothingTarget||(this.videoSmoothedAt=e),this.videoSmoothingTarget=a,this.videoSmoothingTargetAt=e,o=!0),this.hasVideoHistory=!0}else this.hasVideoHistory=!1;let{frameRate:d}=this.videoOptions;if(d>0){let u=1e3/d;this.videoSampleSlot=e-this.videoSampleSlot>u*2?e:this.videoSampleSlot+u}this.videoFrameTime=e,this.videoMediaTime=i,this.videoFrameWidth=this.videoOptions.sampleWidth,this.videoFrameHeight=this.videoOptions.sampleHeight,o||this.showVideoFrame(a)}advanceVideoSmoothing(e){let i=this.videoSmoothingTarget;if(!i)return;let{smoothing:t}=this.videoOptions,r=e-this.videoSmoothingTargetAt>=t*S,s=Math.max(0,e-this.videoSmoothedAt);this.videoSmoothedAt=e;let a=r?1:1-Math.exp(-s/t);this.activeSourceTexture=this.drawSmoothing(i,a),this.releaseRetainedVideoFrame(),this.blurSourceInto(this.nextAlbumFBO),r&&(this.videoSmoothingTarget=null)}showVideoFrame(e){this.videoFrameShown?(this.activeSourceTexture=e,this.releaseRetainedVideoFrame(),this.blurSourceInto(this.nextAlbumFBO)):(this.videoFrameShown=!0,this.shownVideoLoad=this.videoLoadCount,this.processNewImage(e),this.isPlaying||(this.isTransitioning=!1)),this.isPlaying||this.render(this.accumulatedTime)}prepareVideoTargets(e,i){if(!this.videoTargetsStale&&e===this.videoSourceWidth&&i===this.videoSourceHeight)return;this.releaseVideoTargets(),this.videoUploadTexture??=this.createTexture();let{sampleWidth:t,sampleHeight:r,downsampleFactor:s,smoothing:a}=this.videoOptions,n=e,o=i;for(;n>t*s||o>r*s;){let d=Math.max(t,Math.ceil(n/s)),u=Math.max(r,Math.ceil(o/s));if(d===n&&u===o)break;n=d,o=u,this.videoStages.push(this.createFramebuffer(n,o,!0))}if(this.videoStages.push(this.createFramebuffer(t,r,!0)),a>0){let d=this.highPrecisionInputRequested&&this.float32RenderTargets;for(let m=0;m<2;m++)this.videoHistory.push(this.gl2&&d?this.createSizedFramebuffer(t,r,this.gl2.RGBA32F):this.createFramebuffer(t,r,!0));let u=this.gl2?this.halfFloatRenderTargets:!!(this.halfFloatExt&&this.halfFloatLinearExt);this.videoHistoryStep=d?this.float32RenderTargets?0:1/255:u?1/1024:1/255}this.hasVideoHistory=!1,this.videoSourceWidth=e,this.videoSourceHeight=i,this.videoTargetsStale=!1}releaseVideoTargets(){for(let e of[...this.videoStages,...this.videoHistory])e.texture===this.activeSourceTexture?(this.releaseRetainedVideoFrame(),this.retainedVideoFrame=e):this.deleteFramebuffer(e);this.videoStages=[],this.videoHistory=[],this.videoSmoothingTarget=null,this.videoTargetsStale=!0}releaseRetainedVideoFrame(){!this.retainedVideoFrame||this.retainedVideoFrame.texture===this.activeSourceTexture||(this.deleteFramebuffer(this.retainedVideoFrame),this.retainedVideoFrame=null)}getSamplingPrograms(){if(this.samplingPrograms)return this.samplingPrograms;let e=this.gl,i=this.createProgram(p,y),t=this.createProgram(p,B);return this.samplingPrograms={downsample:i,smoothing:t,downsampleUniforms:{texture:e.getUniformLocation(i,"u_texture"),texelSize:e.getUniformLocation(i,"u_texelSize")},smoothingUniforms:{texture:e.getUniformLocation(t,"u_texture"),history:e.getUniformLocation(t,"u_history"),response:e.getUniformLocation(t,"u_response"),minStep:e.getUniformLocation(t,"u_minStep")}},this.samplingPrograms}drawDownsample(e,i){let t=this.gl,r=this.getSamplingPrograms();t.useProgram(r.downsample),this.setupAttributes(),t.bindFramebuffer(t.FRAMEBUFFER,i.framebuffer),t.viewport(0,0,i.width,i.height),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,e),t.uniform1i(r.downsampleUniforms.texture,0),t.uniform2f(r.downsampleUniforms.texelSize,1/i.width,1/i.height),t.drawArrays(t.TRIANGLES,0,6)}drawSmoothing(e,i){let t=this.gl,r=this.getSamplingPrograms(),s=this.videoHistory[this.videoHistoryIndex];this.videoHistoryIndex=1-this.videoHistoryIndex;let a=this.videoHistory[this.videoHistoryIndex];return!s||!a?e:(t.useProgram(r.smoothing),this.setupAttributes(),t.bindFramebuffer(t.FRAMEBUFFER,a.framebuffer),t.viewport(0,0,a.width,a.height),t.activeTexture(t.TEXTURE1),t.bindTexture(t.TEXTURE_2D,s.texture),t.uniform1i(r.smoothingUniforms.history,1),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,e),t.uniform1i(r.smoothingUniforms.texture,0),t.uniform1f(r.smoothingUniforms.response,i),t.uniform1f(r.smoothingUniforms.minStep,this.videoHistoryStep),t.drawArrays(t.TRIANGLES,0,6),a.texture)}processNewImage(e=this.sourceTexture,i=!1){if(e===this.sourceTexture&&!i&&this.unloadVideo(),this.activeSourceTexture=e,this.releaseRetainedVideoFrame(),!this.hasImage){this.blurSourceInto(this.nextAlbumFBO),this.blurSourceInto(this.currentAlbumFBO),this.hasImage=!0,this.isTransitioning=!1;return}let t=this.currentAlbumFBO;this.currentAlbumFBO=this.nextAlbumFBO,this.nextAlbumFBO=t,this.blurSourceInto(this.nextAlbumFBO),this.isTransitioning=!0,this.transitionStartTime=performance.now()}reblurCurrentImage(){this.blurSourceInto(this.nextAlbumFBO)}blurSourceInto(e){let i=this.gl;i.useProgram(this.tintProgram),this.setupAttributes(),i.bindFramebuffer(i.FRAMEBUFFER,this.blurFBO1.framebuffer),i.viewport(0,0,128,128),i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,this.activeSourceTexture),i.uniform1i(this.uniforms.tint.texture,0),i.uniform3fv(this.uniforms.tint.tintColor,this._tintColor),i.uniform1f(this.uniforms.tint.tintIntensity,this._tintIntensity),i.drawArrays(i.TRIANGLES,0,6),i.useProgram(this.blurProgram),this.setupAttributes(),i.uniform2f(this.uniforms.blur.resolution,128,128),i.uniform1i(this.uniforms.blur.texture,0);let t=this.blurFBO1,r=this.blurFBO2;for(let s=0;s<this._blurPasses;s++){i.bindFramebuffer(i.FRAMEBUFFER,r.framebuffer),i.viewport(0,0,128,128),i.bindTexture(i.TEXTURE_2D,t.texture),i.uniform1f(this.uniforms.blur.offset,s+.5),i.drawArrays(i.TRIANGLES,0,6);let a=t;t=r,r=a}i.bindFramebuffer(i.FRAMEBUFFER,e.framebuffer),i.viewport(0,0,128,128),i.bindTexture(i.TEXTURE_2D,t.texture),i.uniform1f(this.uniforms.blur.offset,0),i.drawArrays(i.TRIANGLES,0,6)}resize(){let e=Math.max(1,this.canvas.width),i=Math.max(1,this.canvas.height);(this.warpFBO.width!==e||this.warpFBO.height!==i)&&(this.warpFBO&&this.deleteFramebuffer(this.warpFBO),this.warpFBO=this.createFramebuffer(e,i,!0))}start(){this.disposed||this.isPlaying||(this.isPlaying=!0,this.lastFrameTime=performance.now(),this.video&&(this.video.removeEventListener("pause",this.resumeVideoCallbacks),this.requestVideoFrame(),this.videoFramePending&&(this.videoFramePending=!1,this.processVideoFrame(this.lastFrameTime,this.video.currentTime))),this.animationId=requestAnimationFrame(this.renderLoop))}stop(){this.isPlaying=!1,this.animationId!==null&&(cancelAnimationFrame(this.animationId),this.animationId=null)}renderFrame(e){let i=performance.now();if(e!==void 0)this.render(e,i);else{let t=(i-this.lastFrameTime)/1e3;this.lastFrameTime=i,this._animationSpeed+=(this._targetAnimationSpeed-this._animationSpeed)*.05,this.accumulatedTime+=t*this._animationSpeed,this.render(this.accumulatedTime,i)}}dispose(){if(this.disposed)return;this.disposed=!0,this.stop(),this.unloadVideo();let e=this.gl;this.retainedVideoFrame&&this.deleteFramebuffer(this.retainedVideoFrame);for(let i of this.sampleTargets)this.deleteFramebuffer(i);this.samplingPrograms&&(e.deleteProgram(this.samplingPrograms.downsample),e.deleteProgram(this.samplingPrograms.smoothing)),this.gl2?.deleteBuffer(this.samplePixelBuffer),e.deleteProgram(this.blurProgram),e.deleteProgram(this.blendProgram),e.deleteProgram(this.tintProgram),e.deleteProgram(this.warpProgram),e.deleteProgram(this.outputProgram),e.deleteBuffer(this.positionBuffer),e.deleteBuffer(this.texCoordBuffer),e.deleteTexture(this.sourceTexture),this.deleteFramebuffer(this.blurFBO1),this.deleteFramebuffer(this.blurFBO2),this.deleteFramebuffer(this.currentAlbumFBO),this.deleteFramebuffer(this.nextAlbumFBO),this.deleteFramebuffer(this.warpFBO)}renderLoop=e=>{if(!this.isPlaying)return;let i=(e-this.lastFrameTime)/1e3;this.lastFrameTime=e,this._animationSpeed+=(this._targetAnimationSpeed-this._animationSpeed)*.05,this.accumulatedTime+=i*this._animationSpeed,this.render(this.accumulatedTime,e),this.animationId=requestAnimationFrame(this.renderLoop)};render(e,i=performance.now()){if(this.disposed||!this.hasImage)return;this.advanceVideoSmoothing(i);let t=this.gl,r=Math.max(1,this.canvas.width),s=Math.max(1,this.canvas.height);(this.warpFBO.width!==r||this.warpFBO.height!==s)&&(this.deleteFramebuffer(this.warpFBO),this.warpFBO=this.createFramebuffer(r,s,!0));let a=1;if(this.isTransitioning){let o=Math.max(0,i-this.transitionStartTime);a=this._transitionDuration>0?Math.min(1,o/this._transitionDuration):1,a>=1&&(this.isTransitioning=!1)}let n;if(this.isTransitioning&&a<1){t.useProgram(this.blendProgram),this.setupAttributes(),t.bindFramebuffer(t.FRAMEBUFFER,this.blurFBO1.framebuffer),t.viewport(0,0,128,128),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,this.currentAlbumFBO.texture),t.uniform1i(this.uniforms.blend.texture1,0),t.activeTexture(t.TEXTURE1),t.bindTexture(t.TEXTURE_2D,this.nextAlbumFBO.texture),t.uniform1i(this.uniforms.blend.texture2,1);let o=.5-.5*Math.cos(a*Math.PI);t.uniform1f(this.uniforms.blend.blend,o),t.drawArrays(t.TRIANGLES,0,6),n=this.blurFBO1.texture}else n=this.nextAlbumFBO.texture;t.useProgram(this.warpProgram),this.setupAttributes(),t.bindFramebuffer(t.FRAMEBUFFER,this.warpFBO.framebuffer),t.viewport(0,0,r,s),t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,n),t.uniform1i(this.uniforms.warp.texture,0),t.uniform1f(this.uniforms.warp.time,e),t.uniform1f(this.uniforms.warp.intensity,this._warpIntensity),t.drawArrays(t.TRIANGLES,0,6),t.useProgram(this.outputProgram),this.setupAttributes(),t.bindFramebuffer(t.FRAMEBUFFER,null),t.viewport(0,0,r,s),t.bindTexture(t.TEXTURE_2D,this.warpFBO.texture),t.uniform1i(this.uniforms.output.texture,0),t.uniform1f(this.uniforms.output.saturation,this._saturation),t.uniform1f(this.uniforms.output.dithering,this._dithering),t.uniform1f(this.uniforms.output.time,e),t.uniform1f(this.uniforms.output.scale,this._scale),t.uniform2f(this.uniforms.output.resolution,r,s),t.drawArrays(t.TRIANGLES,0,6)}setupAttributes(){let e=this.gl;e.bindBuffer(e.ARRAY_BUFFER,this.positionBuffer),e.enableVertexAttribArray(this.attribs.position),e.vertexAttribPointer(this.attribs.position,2,e.FLOAT,!1,0,0),e.bindBuffer(e.ARRAY_BUFFER,this.texCoordBuffer),e.enableVertexAttribArray(this.attribs.texCoord),e.vertexAttribPointer(this.attribs.texCoord,2,e.FLOAT,!1,0,0)}createShader(e,i){let t=this.gl,r=t.createShader(e);if(!r)throw new Error("Failed to create shader");if(t.shaderSource(r,this.gl2&&e===t.FRAGMENT_SHADER?`precision highp sampler2D;
${i}`:i),t.compileShader(r),!t.getShaderParameter(r,t.COMPILE_STATUS)){let s=t.getShaderInfoLog(r);throw t.deleteShader(r),new Error(`Shader compile error: ${s}`)}return r}createProgram(e,i){let t=this.gl,r=this.createShader(t.VERTEX_SHADER,e),s=this.createShader(t.FRAGMENT_SHADER,i),a=t.createProgram();if(!a)throw new Error("Failed to create program");if(t.attachShader(a,r),t.attachShader(a,s),t.linkProgram(a),!t.getProgramParameter(a,t.LINK_STATUS)){let n=t.getProgramInfoLog(a);throw t.deleteProgram(a),new Error(`Program link error: ${n}`)}return t.deleteShader(r),t.deleteShader(s),a}createBuffer(e){let i=this.gl,t=i.createBuffer();if(!t)throw new Error("Failed to create buffer");return i.bindBuffer(i.ARRAY_BUFFER,t),i.bufferData(i.ARRAY_BUFFER,e,i.STATIC_DRAW),t}createTexture(){let e=this.gl,i=e.createTexture();if(!i)throw new Error("Failed to create texture");return e.bindTexture(e.TEXTURE_2D,i),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_S,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),i}createFramebuffer(e,i,t=!1){if(this.gl2)return this.createSizedFramebuffer(e,i,t&&this.halfFloatRenderTargets?this.gl2.RGBA16F:this.gl2.RGBA8);let r=this.gl,s=this.createTexture(),n=t&&this.halfFloatExt&&this.halfFloatLinearExt?this.halfFloatExt.HALF_FLOAT_OES:r.UNSIGNED_BYTE;r.texImage2D(r.TEXTURE_2D,0,r.RGBA,e,i,0,r.RGBA,n,null);let o=r.createFramebuffer();if(!o)throw new Error("Failed to create framebuffer");return r.bindFramebuffer(r.FRAMEBUFFER,o),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_2D,s,0),{framebuffer:o,texture:s,width:e,height:i}}createSizedFramebuffer(e,i,t){let r=this.gl2,s=this.createTexture(),a=t===r.RGBA32F?r.FLOAT:t===r.RGBA16F?r.HALF_FLOAT:r.UNSIGNED_BYTE;t===r.RGBA32F&&!this.floatLinearFiltering&&(r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MIN_FILTER,r.NEAREST),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MAG_FILTER,r.NEAREST)),r.texImage2D(r.TEXTURE_2D,0,t,e,i,0,r.RGBA,a,null);let n=r.createFramebuffer();if(!n)throw new Error("Failed to create framebuffer");return r.bindFramebuffer(r.FRAMEBUFFER,n),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_2D,s,0),t!==r.RGBA8&&r.checkFramebufferStatus(r.FRAMEBUFFER)!==r.FRAMEBUFFER_COMPLETE&&(t===r.RGBA32F?this.float32RenderTargets=!1:this.halfFloatRenderTargets=!1,r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MIN_FILTER,r.LINEAR),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MAG_FILTER,r.LINEAR),r.texImage2D(r.TEXTURE_2D,0,r.RGBA8,e,i,0,r.RGBA,r.UNSIGNED_BYTE,null)),{framebuffer:n,texture:s,width:e,height:i}}applyFloatDrawingBuffer(){let e=this.gl2;!e?.drawingBufferStorage||!this.halfFloatRenderTargets||(e.drawingBufferStorage(e.RGBA16F,Math.max(1,this.canvas.width),Math.max(1,this.canvas.height)),this._highPrecisionOutput=e.drawingBufferFormat===e.RGBA16F)}deleteFramebuffer(e){this.gl.deleteFramebuffer(e.framebuffer),this.gl.deleteTexture(e.texture)}};export{F as Kawarp};
