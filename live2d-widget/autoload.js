// 注意：live2d_path 参数应使用绝对路径
// 本站自托管：资源就在博客仓库里，不再走 jsDelivr，避免 CDN 不稳导致看板娘整体加载不出来
const live2d_path = "/live2d-widget/";

// 封装异步加载资源的方法
function loadExternalResource(url, type) {
	return new Promise((resolve, reject) => {
		let tag;

		if (type === "css") {
			tag = document.createElement("link");
			tag.rel = "stylesheet";
			tag.href = url;
		}
		else if (type === "js") {
			tag = document.createElement("script");
			tag.src = url;
		}
		if (tag) {
			tag.onload = () => resolve(url);
			tag.onerror = () => reject(url);
			document.head.appendChild(tag);
		}
	});
}

// ---------- 设备信息采集 + 低配检测 ----------
// 这些 API 全部无需授权：CPU 逻辑核数 / 内存档位（仅 Chromium）/ 屏幕与 DPR /
// 网络状况 / GPU 型号（WEBGL_debug_renderer_info）。结果只打到控制台，不上传。
function collectDeviceInfo() {
	const info = {
		cores: navigator.hardwareConcurrency,   // CPU 逻辑核数
		memoryGB: navigator.deviceMemory,       // 内存 GB（仅 Chromium，最高报 8）
		screen: screen.width + "x" + screen.height,
		dpr: window.devicePixelRatio,
		gpu: "",
		net: (navigator.connection || {}).effectiveType || "",
		saveData: !!(navigator.connection && navigator.connection.saveData)
	};
	try {
		const gl = document.createElement("canvas").getContext("webgl");
		if (gl) {
			const ext = gl.getExtension("WEBGL_debug_renderer_info");
			info.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
		}
	} catch (e) { /* 拿不到 WebGL 信息就留空，不影响加载 */ }
	return info;
}

// 低配判定：信号缺失时按「不低配」处理——宁可多开，不误杀正常机器
function isLowEndDevice(info) {
	if (info.saveData) return true;             // 用户开了省流模式 → 尊重
	let score = 0;
	if (typeof info.cores === "number") {
		if (info.cores <= 2) return true;       // 2 核及以下必是低配
		if (info.cores <= 4) score++;           // 4 核记 1 分
	}
	if (typeof info.memoryGB === "number") {
		if (info.memoryGB <= 2) return true;    // 2GB 内存必是低配
		if (info.memoryGB <= 4) score++;        // 4GB 记 1 分
	}
	return score >= 2;                          // 4 核 + 4GB 这类双低组合才判低配
}

// 加载 live2d.min.js waifu-tips.js 并初始化（waifu.css 体积小，始终加载）
function bootWaifu() {
	return Promise.all([
		loadExternalResource(live2d_path + "live2d.min.js", "js"),
		loadExternalResource(live2d_path + "waifu-tips.js", "js")
	]).then(() => {
		initWidget({
			waifuPath: live2d_path + "waifu-tips.json",
			//apiPath: "https://live2d.fghrsh.net/api/",
			// 模型已整仓搬进站内（source/live2d-widget/model/，约 134MB），默认走本地；
			// 万一本地缺文件，再回退到 CDN。按顺序探测，取第一个可用的。
			cdnPath: [
				"/live2d-widget/",
				"https://fastly.jsdelivr.net/gh/fghrsh/live2d_api/"
			]
		});
	}).catch(() => {
		console.error("Live2D 组件资源加载失败，请刷新重试");
	});
}

if (screen.width >= 768) {
	loadExternalResource(live2d_path + "waifu.css", "css");
	const deviceInfo = collectDeviceInfo();
	const lowEnd = isLowEndDevice(deviceInfo);
	console.log("[live2d] 设备信息:", deviceInfo,
		lowEnd ? "→ 判定为低配，默认不加载看板娘" : "→ 性能足够，正常加载");
	if (!lowEnd || localStorage.getItem("waifu-force") === "on") {
		bootWaifu();
	} else {
		// 低配默认关闭，但留一个「看板娘」按钮：点一下 = 从此启用（记入 waifu-force）
		// 本脚本可能在 body 就绪前执行，等 DOM 可用再插按钮
		const mountToggle = () => {
			const btn = document.createElement("div");
			btn.id = "waifu-toggle";
			btn.className = "waifu-toggle-active"; // 默认样式藏在屏幕外，挂上这个类才滑入
			btn.innerHTML = "<span>看板娘</span>";
			btn.title = "这台设备性能较弱，看板娘已默认关闭；点此仍可启用";
			btn.addEventListener("click", () => {
				localStorage.setItem("waifu-force", "on");
				btn.remove();
				bootWaifu();
			});
			document.body.appendChild(btn);
		};
		if (document.body) mountToggle();
		else document.addEventListener("DOMContentLoaded", mountToggle);
	}
}
// initWidget 第一个参数为 waifu-tips.json 的路径，第二个参数为 API 地址
// API 后端可自行搭建，参考 https://github.com/fghrsh/live2d_api
// 初始化看板娘会自动加载指定目录下的 waifu-tips.json

console.log(`
  く__,.ヘヽ.        /  ,ー､ 〉
           ＼ ', !-─‐-i  /  /´
           ／｀ｰ'       L/／｀ヽ､
         /   ／,   /|   ,   ,       ',
       ｲ   / /-‐/  ｉ  L_ ﾊ ヽ!   i
        ﾚ ﾍ 7ｲ｀ﾄ   ﾚ'ｧ-ﾄ､!ハ|   |
          !,/7 '0'     ´0iソ|    |
          |.从"    _     ,,,, / |./    |
          ﾚ'| i＞.､,,__  _,.イ /   .i   |
            ﾚ'| | / k_７_/ﾚ'ヽ,  ﾊ.  |
              | |/i 〈|/   i  ,.ﾍ |  i  |
             .|/ /  ｉ：    ﾍ!    ＼  |
              kヽ>､ﾊ    _,.ﾍ､    /､!
              !'〈//｀Ｔ´', ＼ ｀'7'ｰr'
              ﾚ'ヽL__|___i,___,ンﾚ|ノ
                  ﾄ-,/  |___./
                  'ｰ'    !_,.:
`);

