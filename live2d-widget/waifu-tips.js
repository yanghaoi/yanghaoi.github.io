/*
 * Live2D Widget
 * https://github.com/stevenjoezhang/live2d-widget
 */

function loadWidget(config) {
	let { waifuPath, apiPath, cdnPath } = config;
	let useCDN = false, modelList, activeCdn = null, cdnList = [];
	if (typeof cdnPath === "string") {
		useCDN = true;
		cdnList = [cdnPath];
	} else if (Array.isArray(cdnPath)) {
		// 支持传入多个 CDN：按顺序自动探测，避免单一源不可用导致看板娘加载失败
		useCDN = true;
		cdnList = cdnPath.slice();
	} else if (typeof apiPath === "string") {
		if (!apiPath.endsWith("/")) apiPath += "/";
	} else {
		console.error("Invalid initWidget argument!");
		return;
	}
	if (useCDN) {
		cdnList = cdnList.filter(Boolean).map(url => url.endsWith("/") ? url : url + "/");
		if (cdnList.length === 0) {
			console.error("Invalid cdnPath!");
			return;
		}
		activeCdn = cdnList[0];
	}
	localStorage.removeItem("waifu-display");
	sessionStorage.removeItem("waifu-text");
	document.body.insertAdjacentHTML("beforeend", `<div id="waifu" class="waifu-loading">
			<div id="waifu-tips"></div>
			<canvas id="live2d" width="350" height="350"></canvas>
			<div id="waifu-tool">
				<span class="fa fa-lg fa-comment"></span>
				<span class="fa fa-lg fa-paper-plane"></span>
				<span class="fa fa-lg fa-user-circle"></span>
				<span class="fa fa-lg fa-street-view"></span>
				<span class="fa fa-lg fa-camera-retro"></span>
				<span class="fa fa-lg fa-info-circle"></span>
				<span class="fa fa-lg fa-times"></span>
			</div>
		</div>`);
	// https://stackoverflow.com/questions/24148403/trigger-css-transition-on-appended-element
	setTimeout(() => {
		document.getElementById("waifu").style.bottom = 0;
	}, 0);

	function randomSelection(obj) {
		return Array.isArray(obj) ? obj[Math.floor(Math.random() * obj.length)] : obj;
	}
	// 带超时的 fetch：网络卡住时不会一直等；force-cache 让下过的资源优先走本地缓存
	async function fetchWithTimeout(url, timeout) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout || 8000);
		try {
			return await fetch(url, { signal: controller.signal, cache: "force-cache" });
		} finally {
			clearTimeout(timer);
		}
	}
	// 完整下载并丢弃 body，确保资源真正进入浏览器缓存，之后 live2d.min.js 的 XHR 才能命中缓存
	async function preloadAsset(url, timeout) {
		try {
			const response = await fetchWithTimeout(url, timeout);
			if (!response.ok) return false;
			await response.arrayBuffer();
			return true;
		} catch (e) {
			return false;
		}
	}
	// CDN 候选：当前可用的排最前
	function cdnCandidates() {
		if (!activeCdn) return cdnList.slice();
		return [activeCdn].concat(cdnList.filter(url => url !== activeCdn));
	}
	// 检测用户活动状态，并在空闲时显示消息
	let userAction = false,
		userActionTimer,
		messageTimer,
		messageArray = ["好久不见，日子过得好快呢……", "大坏蛋！你都多久没理人家了呀，嘤嘤嘤～", "嗨～快来逗我玩吧！", "拿小拳拳锤你胸口！", "记得把小家加入 Adblock 白名单哦！"];
	window.addEventListener("mousemove", () => userAction = true);
	window.addEventListener("keydown", () => userAction = true);
	setInterval(() => {
		if (userAction) {
			userAction = false;
			clearInterval(userActionTimer);
			userActionTimer = null;
		} else if (!userActionTimer) {
			userActionTimer = setInterval(() => {
				showMessage(randomSelection(messageArray), 6000, 9);
			}, 20000);
		}
	}, 1000);

	// ============ GPU 省电：阅读 / 空闲 / 页面不可见时休眠 Live2D 渲染 ============
	// live2d.min.js 内部用 requestAnimationFrame 递归重绘 WebGL canvas，待机动画
	//（呼吸/眨眼）让 GPU 常驻 10%~30%。它没暴露暂停接口，所以在页面层面给 rAF
	// 加一道闸门：休眠期间回调只挂起不入队（渲染循环整体停转，GPU 归零），
	// 恢复时把挂起的回调重新交给原生 rAF，循环自己会继续转起来。
	// 休眠条件：前台连续 3 分钟无输入，或页面不在前台（切标签页/最小化）。
	// 唤醒条件：鼠标移到看板娘上并停留（防抖 300ms），或直接点她——
	// 阅读文章时的滚动、页面里的鼠标移动都算「阅读」，不会吵醒她。
	let l2dPageHidden = false,      // 页面是否不在前台（切标签页/最小化）
		l2dPaused = false,          // 是否处于休眠
		l2dIdleTimer = null,
		l2dIdleMs = 180000,         // 连续无操作 3 分钟后休眠
		l2dWakeTimer = null,
		l2dWakeDelay = 300,         // 悬停防抖：停留 300ms 才唤醒
		l2dPendingRaf = new Map(),  // 休眠期间挂起的 rAF 回调
		l2dRafSeq = 0;
	const l2dNativeRaf = window.requestAnimationFrame.bind(window);
	const l2dNativeCancel = window.cancelAnimationFrame.bind(window);

	// 休眠期间接管 rAF：回调挂起不执行，GPU 零消耗；唤醒时统一放行
	window.requestAnimationFrame = function (cb) {
		if (l2dPageHidden || l2dPaused) {
			const id = --l2dRafSeq; // 负数 id，与原生句柄空间隔离
			l2dPendingRaf.set(id, cb);
			return id;
		}
		return l2dNativeRaf(cb);
	};
	window.cancelAnimationFrame = function (id) {
		if (l2dPendingRaf.delete(id)) return;
		l2dNativeCancel(id);
	};

	function l2dResume() {
		if (!l2dPendingRaf.size) return;
		const pending = Array.from(l2dPendingRaf.values());
		l2dPendingRaf.clear();
		pending.forEach(cb => l2dNativeRaf(cb));
	}

	function l2dSetPaused(next) {
		if (l2dPaused === next) return;
		l2dPaused = next;
		if (next) {
			// 切后台时用户看不到，不必弹这句话
			if (!l2dPageHidden) showMessage("我去眯一会儿，把鼠标放到我身上就能叫醒我哦～", 4000, 9);
		} else {
			l2dResume();
		}
	}

	// 记录一次用户活动：只在醒着时续空闲计时；休眠中的阅读动作不构成唤醒
	function l2dNoteActivity() {
		if (l2dPageHidden || l2dPaused) return;
		if (l2dIdleTimer) clearTimeout(l2dIdleTimer);
		l2dIdleTimer = setTimeout(() => {
			l2dIdleTimer = null;
			l2dSetPaused(true);
		}, l2dIdleMs);
	}

	function l2dWake() {
		if (l2dWakeTimer) {
			clearTimeout(l2dWakeTimer);
			l2dWakeTimer = null;
		}
		if (l2dPageHidden) return;
		l2dSetPaused(false);
		l2dNoteActivity();
	}

	// 悬停防抖：移上看板娘后停留 l2dWakeDelay 才真正唤醒，扫过不误触
	function l2dArmWake() {
		if (!l2dPaused || l2dPageHidden || l2dWakeTimer) return;
		l2dWakeTimer = setTimeout(() => {
			l2dWakeTimer = null;
			l2dWake();
		}, l2dWakeDelay);
	}

	// 切标签页 / 最小化浏览器 / 切到其他窗口 → 立即休眠；
	// 回到前台不自动唤醒（多半是切回来继续阅读），动了看板娘才会醒
	document.addEventListener("visibilitychange", () => {
		l2dPageHidden = document.hidden;
		if (l2dPageHidden) {
			if (l2dWakeTimer) { clearTimeout(l2dWakeTimer); l2dWakeTimer = null; }
			if (l2dIdleTimer) { clearTimeout(l2dIdleTimer); l2dIdleTimer = null; }
			l2dSetPaused(true);
		} else {
			l2dNoteActivity();
		}
	});

	// 唤醒入口：悬停在看板娘上（防抖），或直接点她（工具条按钮需要渲染）
	const waifuBox = document.getElementById("waifu");
	if (waifuBox) {
		waifuBox.addEventListener("mouseenter", l2dArmWake);
		// 光标可能一直停在她身上时进入休眠（比如鼠标搁着没动 3 分钟），
		// 此时不会再触发 mouseenter，靠 mousemove 补一条唤醒路径
		waifuBox.addEventListener("mousemove", l2dArmWake);
		waifuBox.addEventListener("mouseleave", () => {
			if (l2dWakeTimer) { clearTimeout(l2dWakeTimer); l2dWakeTimer = null; }
		});
		waifuBox.addEventListener("pointerdown", () => l2dWake());
	}

	// 任何输入都算「用户在用页面」：醒着时续空闲计时（休眠时忽略）
	["mousemove", "keydown", "mousedown", "touchstart", "wheel", "scroll"].forEach(evt =>
		window.addEventListener(evt, l2dNoteActivity, { passive: true })
	);
	l2dNoteActivity();

	(function registerEventListener() {
		document.querySelector("#waifu-tool .fa-comment").addEventListener("click", showHitokoto);
		document.querySelector("#waifu-tool .fa-paper-plane").addEventListener("click", () => {
			if (window.Asteroids) {
				if (!window.ASTEROIDSPLAYERS) window.ASTEROIDSPLAYERS = [];
				window.ASTEROIDSPLAYERS.push(new Asteroids());
			} else {
				const script = document.createElement("script");
				script.src = "https://cdn.jsdelivr.net/gh/stevenjoezhang/asteroids/asteroids.js";
				document.head.appendChild(script);
			}
		});
		document.querySelector("#waifu-tool .fa-user-circle").addEventListener("click", loadOtherModel);
		document.querySelector("#waifu-tool .fa-street-view").addEventListener("click", loadRandModel);
		document.querySelector("#waifu-tool .fa-camera-retro").addEventListener("click", () => {
			showMessage("照好了嘛，是不是很可爱呢？", 6000, 9);
			Live2D.captureName = "photo.png";
			Live2D.captureFrame = true;
		});
		document.querySelector("#waifu-tool .fa-info-circle").addEventListener("click", () => {
			open("https://github.com/stevenjoezhang/live2d-widget");
		});
		document.querySelector("#waifu-tool .fa-times").addEventListener("click", () => {
			localStorage.setItem("waifu-display", Date.now());
			showMessage("愿你有一天能与重要的人重逢。", 2000, 11);
			document.getElementById("waifu").style.bottom = "-500px";
			setTimeout(() => {
				document.getElementById("waifu").style.display = "none";
				document.getElementById("waifu-toggle").classList.add("waifu-toggle-active");
			}, 3000);
		});
		const devtools = () => {};
		console.log("%c", devtools);
		devtools.toString = () => {
			showMessage("哈哈，你打开了控制台，是想要看看我的小秘密吗？", 6000, 9);
		};
		window.addEventListener("copy", () => {
			showMessage("你都复制了些什么呀，转载要记得加上出处哦！", 6000, 9);
		});
		window.addEventListener("visibilitychange", () => {
			if (!document.hidden) showMessage("哇，你终于回来了～", 6000, 9);
		});
	})();

	(function welcomeMessage() {
		let text;
		if (location.pathname === "/") { // 如果是主页
			const now = new Date().getHours();
			if (now > 5 && now <= 7) text = "早上好！一日之计在于晨，美好的一天就要开始了。";
			else if (now > 7 && now <= 11) text = "上午好！工作顺利嘛，不要久坐，多起来走动走动哦！";
			else if (now > 11 && now <= 13) text = "中午了，工作了一个上午，现在是午餐时间！";
			else if (now > 13 && now <= 17) text = "午后很容易犯困呢，今天的运动目标完成了吗？";
			else if (now > 17 && now <= 19) text = "傍晚了！窗外夕阳的景色很美丽呢，最美不过夕阳红～";
			else if (now > 19 && now <= 21) text = "晚上好，今天过得怎么样？";
			else if (now > 21 && now <= 23) text = ["已经这么晚了呀，早点休息吧，晚安～", "深夜时要爱护眼睛呀！"];
			else text = "你是夜猫子呀？这么晚还不睡觉，明天起的来嘛？";
		} else if (document.referrer !== "") {
			const referrer = new URL(document.referrer),
				domain = referrer.hostname.split(".")[1];
			if (location.hostname === referrer.hostname) text = `欢迎阅读<span>「${document.title.split(" - ")[0]}」</span>`;
			else if (domain === "baidu") text = `Hello！来自 百度搜索 的朋友<br>你是搜索 <span>${referrer.search.split("&wd=")[1].split("&")[0]}</span> 找到的我吗？`;
			else if (domain === "so") text = `Hello！来自 360搜索 的朋友<br>你是搜索 <span>${referrer.search.split("&q=")[1].split("&")[0]}</span> 找到的我吗？`;
			else if (domain === "google") text = `Hello！来自 谷歌搜索 的朋友<br>欢迎阅读<span>「${document.title.split(" - ")[0]}」</span>`;
			else text = `Hello！来自 <span>${referrer.hostname}</span> 的朋友`;
		} else {
			text = `欢迎阅读<span>「${document.title.split(" - ")[0]}」</span>`;
		}
		// 第一句先交代「我会吃 GPU」这件事，用本人的口吻说，别让访客一头雾水
		showMessage("人家是 WebGL 画出来的小家伙，会一直悄悄占用一点 GPU 哦～电脑要是烫起来了，就点我头上的 × 让我下去休息吧！", 8000, 8);
		// GPU 提示说完，再上原本的欢迎语
		setTimeout(() => showMessage(text, 7000, 8), 8000);
	})();

	function showHitokoto() {
		// 增加 hitokoto.cn 的 API
		// 先给一句即时反馈，避免网络慢时点了半天没动静、看着像卡住
		showMessage("让我想想说点什么…", 8000, 9);
		fetchWithTimeout("https://v1.hitokoto.cn", 8000)
			.then(response => response.json())
			.then(result => {
				const text = `这句一言来自 <span>「${result.from}」</span>，是 <span>${result.creator}</span> 在 hitokoto.cn 投稿的。`;
				showMessage(result.hitokoto, 6000, 9);
				setTimeout(() => {
					showMessage(text, 4000, 9);
				}, 6000);
			})
			.catch(() => {
				showMessage("一言服务暂时连不上，待会儿再试试吧～", 4000, 9);
			});
	}

	function showMessage(text, timeout, priority) {
		if (!text || (sessionStorage.getItem("waifu-text") && sessionStorage.getItem("waifu-text") > priority)) return;
		if (messageTimer) {
			clearTimeout(messageTimer);
			messageTimer = null;
		}
		text = randomSelection(text);
		sessionStorage.setItem("waifu-text", priority);
		const tips = document.getElementById("waifu-tips");
		tips.innerHTML = text;
		tips.classList.add("waifu-tips-active");
		messageTimer = setTimeout(() => {
			sessionStorage.removeItem("waifu-text");
			tips.classList.remove("waifu-tips-active");
		}, timeout);
	}

	(function initModel() {
		let modelId = localStorage.getItem("modelId"),
			modelTexturesId = localStorage.getItem("modelTexturesId");
		if (modelId === null) {
			// 首次访问加载 指定模型 的 指定材质
			modelId = 1; // 模型 ID
			modelTexturesId = 53; // 材质 ID
		}
		loadModel(modelId, modelTexturesId);
		fetchWithTimeout(waifuPath, 8000)
			.then(response => response.json())
			.catch(() => null)
			.then(result => {
				if (!result) return;
				window.addEventListener("mouseover", event => {
					for (let { selector, text } of result.mouseover) {
						if (!event.target.matches(selector)) continue;
						text = randomSelection(text);
						text = text.replace("{text}", event.target.innerText);
						showMessage(text, 4000, 8);
						return;
					}
				});
				window.addEventListener("click", event => {
					for (let { selector, text } of result.click) {
						if (!event.target.matches(selector)) continue;
						text = randomSelection(text);
						text = text.replace("{text}", event.target.innerText);
						showMessage(text, 4000, 8);
						return;
					}
				});
				result.seasons.forEach(({ date, text }) => {
					const now = new Date(),
						after = date.split("-")[0],
						before = date.split("-")[1] || after;
					if ((after.split("/")[0] <= now.getMonth() + 1 && now.getMonth() + 1 <= before.split("/")[0]) && (after.split("/")[1] <= now.getDate() && now.getDate() <= before.split("/")[1])) {
						text = randomSelection(text);
						text = text.replace("{year}", now.getFullYear());
						//showMessage(text, 7000, true);
						messageArray.push(text);
					}
				});
			});
	})();

	// 依次探测各 CDN，拿到可用的 model_list.json
	async function loadModelList() {
		for (const base of cdnCandidates()) {
			try {
				const response = await fetchWithTimeout(`${base}model_list.json`, 8000);
				if (!response.ok) continue;
				modelList = await response.json();
				activeCdn = base;
				return modelList;
			} catch (e) {
				// 换下一个源
			}
		}
		modelList = null;
		return null;
	}

	// 关键：先把模型用到的 moc/贴图全部预取进缓存，确认都拿到了再交给 loadlive2d。
	// 否则 loadlive2d 会先清空画布，加载失败就只剩空白（表现为「切换人物后人物消失」）。
	async function applyModel(target, message) {
		for (const base of cdnCandidates()) {
			try {
				const response = await fetchWithTimeout(`${base}model/${target}/index.json`, 8000);
				if (!response.ok) continue;
				const setting = await response.json();
				const files = [setting.model].concat(setting.textures || []).filter(Boolean);
				const results = await Promise.all(files.map(file => preloadAsset(`${base}model/${target}/${file}`, 15000)));
				if (!results.every(Boolean)) continue;
				activeCdn = base;
				loadlive2d("live2d", `${base}model/${target}/index.json`);
				showMessage(message, 4000, 10);
				// 资源都预取成功、loadlive2d 已调用，再等一小会儿让首帧画出来，然后才显示工具条
				setTimeout(() => {
					const w = document.getElementById("waifu");
					if (w) w.classList.remove("waifu-loading");
				}, 400);
				return true;
			} catch (e) {
				// 换下一个源
			}
		}
		// 所有源都失败：保留当前模型，绝不清空画布
		showMessage("模型加载失败了，检查一下网络，或稍后再试试～", 5000, 11);
		return false;
	}

	async function loadModel(modelId, modelTexturesId, message) {
		if (useCDN) {
			if (!modelList) await loadModelList();
			if (!modelList || !modelList.models) {
				showMessage("模型列表加载失败，检查一下网络，或稍后再试试～", 5000, 11);
				return;
			}
			const target = randomSelection(modelList.models[modelId]);
			// 加载成功才落盘，避免失败后状态被写脏
			if (await applyModel(target, message)) {
				localStorage.setItem("modelId", modelId);
				localStorage.setItem("modelTexturesId", modelTexturesId);
			}
			return;
		}
		localStorage.setItem("modelId", modelId);
		localStorage.setItem("modelTexturesId", modelTexturesId);
		showMessage(message, 4000, 10);
		loadlive2d("live2d", `${apiPath}get/?id=${modelId}-${modelTexturesId}`);
		console.log(`Live2D 模型 ${modelId}-${modelTexturesId} 加载完成`);
	}

	async function loadRandModel() {
		const modelId = localStorage.getItem("modelId"),
			modelTexturesId = localStorage.getItem("modelTexturesId");
		if (useCDN) {
			if (!modelList) await loadModelList();
			if (!modelList || !modelList.models) {
				showMessage("模型列表加载失败，检查一下网络，或稍后再试试～", 5000, 11);
				return;
			}
			const group = modelList.models[modelId];
			// 该模型组只有一套时，别假装换装成功
			if (!Array.isArray(group) || group.length <= 1) {
				showMessage("我还没有其他衣服呢！", 4000, 10);
				return;
			}
			await applyModel(randomSelection(group), "我的新衣服好看嘛？");
		} else {
			// 可选 "rand"(随机), "switch"(顺序)
			fetch(`${apiPath}rand_textures/?id=${modelId}-${modelTexturesId}`)
				.then(response => response.json())
				.then(result => {
					if (result.textures.id === 1 && (modelTexturesId === 1 || modelTexturesId === 0)) showMessage("我还没有其他衣服呢！", 4000, 10);
					else loadModel(modelId, result.textures.id, "我的新衣服好看嘛？");
				})
				.catch(() => showMessage("换装失败了，待会儿再试试～", 4000, 10));
		}
	}

	async function loadOtherModel() {
		let modelId = localStorage.getItem("modelId");
		if (useCDN) {
			if (!modelList) await loadModelList();
			if (!modelList || !modelList.models) {
				showMessage("模型列表加载失败，检查一下网络，或稍后再试试～", 5000, 11);
				return;
			}
			const index = (++modelId >= modelList.models.length) ? 0 : modelId;
			loadModel(index, 0, modelList.messages[index]);
		} else {
			fetch(`${apiPath}switch/?id=${modelId}`)
				.then(response => response.json())
				.then(result => {
					loadModel(result.model.id, 0, result.model.message);
				})
				.catch(() => showMessage("切换失败了，待会儿再试试～", 4000, 10));
		}
	}
}

function initWidget(config, apiPath) {
	if (typeof config === "string") {
		config = {
			waifuPath: config,
			apiPath
		};
	}
	document.body.insertAdjacentHTML("beforeend", `<div id="waifu-toggle">
			<span>看板娘</span>
		</div>`);
	const toggle = document.getElementById("waifu-toggle");
	toggle.addEventListener("click", () => {
		toggle.classList.remove("waifu-toggle-active");
		if (toggle.getAttribute("first-time")) {
			loadWidget(config);
			toggle.removeAttribute("first-time");
		} else {
			localStorage.removeItem("waifu-display");
			document.getElementById("waifu").style.display = "";
			setTimeout(() => {
				document.getElementById("waifu").style.bottom = 0;
			}, 0);
		}
	});
	if (localStorage.getItem("waifu-display") && Date.now() - localStorage.getItem("waifu-display") <= 86400000) {
		toggle.setAttribute("first-time", true);
		setTimeout(() => {
			toggle.classList.add("waifu-toggle-active");
		}, 0);
	} else {
		loadWidget(config);
	}
}
