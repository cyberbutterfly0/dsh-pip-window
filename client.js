/**
 * dsh-pip-window — 客户端半
 *
 * M0：契约自检（bundle 物化 / slot 注册 / 点击回调）
 * M1：弹出真正的 Document Picture-in-Picture 窗口 + 把主文档样式搬运过去
 * M2：接真实会话数据 —— 读当前会话、订阅事件窗（含流式 live chunk）、发送、停止
 * M3：思考/工具改成可比对齐 dsh 的可折叠行，排版（字体族与字重）对标主文档
 * M4：自绘 PiP 风格图标（替换 IconFullscreen）；输入框支持发送图片（选择 + 粘贴）
 *
 * 本文件是零构建的手写 CJS 式 bundle：没有 JSX/TS，React 全部用 createElement。
 * 数据来源是官方客户端服务 ctx.sessions（不是自建 HTTP 端点）：
 *   sessions.retain(id, { source }) -> reference.ready -> binding
 *   binding.eventSource  : ObservableSnapshot<{entries, hasMore, revision, change}>
 *   binding.session      : ObservableSnapshot<SessionSnapshot> + prompt()/cancel()
 *
 * 调试：localStorage.setItem('dsh-pip-window:debug','1') 后重开小窗可打开诊断日志。
 */
window.__ModuleLoader__.load({
	id: 'dsh-pip-window',
	factory(require) {
		const React = require('react');
		const ReactDOMClient = require('react-dom/client');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

		const h = React.createElement;
		const MarkdownText = primitives.MarkdownText;
		const DisclosureRow = primitives.DisclosureRow;
		const IconSend = primitives.IconPaperPlaneOutlineRegular;
		const IconStop = primitives.IconStopFillRegular;
		const IconThink = primitives.IconThinkOutlineRegular;
		const IconTool = primitives.IconApiOutlineRegular;
		const IconPaperclip = primitives.IconPaperclipOutlineRegular;
		const IconClose = primitives.IconCloseOutlineRegular;

		/**
		 * 自绘的「置顶小窗」图标：外框只保留左/下/右三段（右上留口），
		 * 右上角嵌一个小方框。几何与描边遵循 dsh 产品图标规范：
		 * viewBox 0 0 16 16、fill none、stroke currentColor、Regular 描边 1。
		 */
		const PipWindowArtwork = ({ size = 16, className, strokeWidth }) =>
			h(
				'svg',
				{
					width: size,
					height: size,
					className,
					viewBox: '0 0 16 16',
					fill: 'none',
					xmlns: 'http://www.w3.org/2000/svg',
					'aria-hidden': 'true',
					strokeWidth,
				},
				[
					h('path', {
						key: 'frame',
						d: 'M5 2.5A2.5 2.5 0 0 0 2.5 5v6A2.5 2.5 0 0 0 5 13.5h6a2.5 2.5 0 0 0 2.5-2.5V9.3',
						stroke: 'currentColor',
						strokeLinecap: 'round',
						strokeLinejoin: 'round',
					}),
					h('rect', {
						key: 'inner',
						x: '9',
						y: '2.5',
						width: '4.5',
						height: '4.5',
						rx: '1.5',
						stroke: 'currentColor',
						strokeLinecap: 'round',
						strokeLinejoin: 'round',
					}),
				],
			);
		const IconPipWindow = (props) => h(PipWindowArtwork, { ...props, strokeWidth: props.strokeWidth == null ? 1 : props.strokeWidth });

		const TAG = '[dsh-pip-window]';
		const log = (...args) => console.log(TAG, ...args);
		const warn = (...args) => console.warn(TAG, ...args);

		/** 诊断日志开关（pip rows / pip dom 这类高频输出）。默认关闭。 */
		let DEBUG = false;
		try {
			if (localStorage.getItem('dsh-pip-window:debug') === '1') DEBUG = true;
		} catch {
			/* 忽略 */
		}
		const dlog = (...args) => {
			if (DEBUG) console.log(TAG, ...args);
		};

		/** 客户端根 ctx 与 sessions 服务，apply 时填充。 */
		let rootCtx = null;
		let sessionsService = null;

		/** MarkdownText 的 labels 必须引用稳定（新 identity 会丢弃流式渲染缓存）。 */
		const MD_LABELS = Object.freeze({
			code: Object.freeze({ copyLabel: '复制', copiedLabel: '已复制' }),
			footnotes: '脚注',
		});

		/* ==================================================================
		 * M1 —— 样式搬运
		 * PiP 是一个全新的 document：全局样式表、body[data-ds-dark-theme]、
		 * CSS 变量、根字号都不继承，必须显式搬过去。
		 * 实测（M1）：adoptedStyleSheets 为 0，dsh 的 142 张表全在 DOM 的
		 * <style> 标签里，所以「克隆」就是正解，不需要逐条 setProperty。
		 * ================================================================== */

		function collectCustomProperties() {
			const out = {};
			for (const el of [document.documentElement, document.body]) {
				if (!el) continue;
				const inline = el.style;
				for (let i = 0; i < inline.length; i += 1) {
					const name = inline[i];
					if (name.startsWith('--')) out[name] = inline.getPropertyValue(name);
				}
				const computed = getComputedStyle(el);
				for (let i = 0; i < computed.length; i += 1) {
					const name = computed[i];
					if (name.startsWith('--')) out[name] = computed.getPropertyValue(name);
				}
			}
			return out;
		}

		function mirrorAttributes(source, target) {
			for (const attr of Array.from(source.attributes)) {
				try {
					target.setAttribute(attr.name, attr.value);
				} catch {
					/* 个别属性在目标 document 上非法，跳过 */
				}
			}
		}

		function mirrorDocument(doc) {
			const properties = collectCustomProperties();
			const styles = Array.from(document.querySelectorAll('style'));
			const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
			const adopted = document.adoptedStyleSheets || [];

			// ① 主题属性（body[data-ds-dark-theme] 不搬 → 克隆来的规则全部落空）
			mirrorAttributes(document.documentElement, doc.documentElement);
			if (document.body && doc.body) mirrorAttributes(document.body, doc.body);

			// ② 克隆每一张 <style>（顺序保留，层叠才正确）
			let styleCount = 0;
			for (const node of styles) {
				try {
					doc.head.appendChild(doc.importNode(node, true));
					styleCount += 1;
				} catch {
					/* 忽略单张表的失败 */
				}
			}

			// ③ 克隆外链样式表
			let linkCount = 0;
			for (const node of links) {
				try {
					doc.head.appendChild(doc.importNode(node, true));
					linkCount += 1;
				} catch {
					/* 忽略 */
				}
			}

			// ④ adoptedStyleSheets 兜底（实测 dsh 不用，但别赌）
			let adoptedCount = 0;
			for (const sheet of adopted) {
				try {
					const copy = new CSSStyleSheet();
					copy.replaceSync(Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n'));
					doc.adoptedStyleSheets = [...(doc.adoptedStyleSheets || []), copy];
					adoptedCount += 1;
				} catch {
					/* 跨域表读不了 cssRules，忽略 */
				}
			}

			// ⑤ 变量逐条兜底写到两侧
			const root = doc.documentElement;
			const names = Object.keys(properties);
			for (const name of names) {
				root.style.setProperty(name, properties[name]);
				if (doc.body) doc.body.style.setProperty(name, properties[name]);
			}

			// ⑥ 根字号不继承，显式搬
			const rootFontSize = getComputedStyle(document.documentElement).fontSize;
			root.style.fontSize = rootFontSize;

			// ⑦ 排版也不继承：PiP 实测落到 "Noto Sans SC"，与主文档的字体栈不同，
			//    字重/行高同样会跑偏。把主文档 body 的计算排版显式写进 PiP body
			//    （inline style 优先级压过样式表，所以这一步必须放在克隆之后）。
			let typography = null;
			if (document.body && doc.body) {
				const computed = getComputedStyle(document.body);
				typography = {
					fontFamily: computed.fontFamily,
					fontSize: computed.fontSize,
					fontWeight: computed.fontWeight,
					fontStyle: computed.fontStyle,
					lineHeight: computed.lineHeight,
					letterSpacing: computed.letterSpacing,
					color: computed.color,
				};
				for (const key of Object.keys(typography)) {
					if (typography[key]) doc.body.style[key] = typography[key];
				}
			}

			return {
				styleCount,
				linkCount,
				adoptedCount,
				propertyCount: names.length,
				rootFontSize,
				typography,
			};
		}

		function probeTokens(doc) {
			const computed = getComputedStyle(doc.body);
			return {
				background: computed.backgroundColor,
				color: computed.color,
				fontFamily: computed.fontFamily,
				fontSize: computed.fontSize,
				fontWeight: computed.fontWeight,
				lineHeight: computed.lineHeight,
			};
		}

		/**
		 * PiP 自己的布局样式。颜色刻意用「半透明中性叠加」而不是猜 token 名：
		 * 主题变量已经搬过来了（411 个），文字色/背景色由 body 继承，深浅两套主题
		 * 都能直接看。字号用 dsh 的正文档 token（取不到才回落 13px）。
		 */
		/** 侧边栏入口按钮的样式（注入主文档，不是 PiP）。对标 settings-general 的 `.VOzbGW_trigger` 非 rail 变体，但颜色走 --dsw-* token。 */
		const TRIGGER_CSS = [
			'.dsh-pip-trigger{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:auto;min-width:0;height:42px;margin:0;padding:0 10px 0 8px;border:none;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:14px;line-height:22px;cursor:pointer;overflow:hidden;flex:1 1 auto}',
			'.dsh-pip-trigger:hover,.dsh-pip-trigger:active{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}',
			'.dsh-pip-trigger:focus-visible{outline:2px solid var(--dsw-alias-border-primary,rgba(127,127,127,.6));outline-offset:-2px}',
			'.dsh-pip-trigger-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
			'[data-sidebar-collapsed] .dsh-pip-trigger{flex:none;justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0}',
			'[data-sidebar-collapsed] .dsh-pip-trigger-label{display:none}',
		].join('\n');

		/** 幂等注入主文档样式。少了这一步，侧边栏按钮会退回浏览器默认 button 外观（就是那圈灰白底+边框）。 */
		function ensureTriggerStyle() {
			try {
				if (document.getElementById('dsh-pip-window-trigger-style')) return;
				const style = document.createElement('style');
				style.id = 'dsh-pip-window-trigger-style';
				style.setAttribute('data-plugin', 'dsh-pip-window');
				style.textContent = TRIGGER_CSS;
				document.head.appendChild(style);
			} catch (err) {
				warn('trigger style inject failed', err);
			}
		}

		const PIP_CSS = [
			'*{box-sizing:border-box}',
			'html,body{margin:0;padding:0;height:100%}',
			'#dsh-pip-root{height:100%}',
			'.dsh-pip-shell{display:flex;flex-direction:column;height:100%;font-size:var(--dsh-content-font-size,13px);line-height:1.6}',
			'.dsh-pip-header{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(127,127,127,.25);flex:0 0 auto}',
			'.dsh-pip-title{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;font-size:12px}',
			'.dsh-pip-meta{flex:0 0 auto;font-size:11px;opacity:.6}',
			'.dsh-pip-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:0;background:transparent;color:inherit;cursor:pointer;border-radius:6px;padding:4px;font:inherit;opacity:.75}',
			'.dsh-pip-btn:hover{background:rgba(127,127,127,.16);opacity:1}',
			'.dsh-pip-btn[disabled]{opacity:.35;cursor:default}',
			'.dsh-pip-body{flex:1 1 auto;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:8px}',
			'.dsh-pip-placeholder{margin:auto;text-align:center;font-size:12px;opacity:.6;line-height:1.9}',
			'.dsh-pip-row{display:flex;flex-direction:column;gap:2px}',
			'.dsh-pip-role{font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.5}',
			'.dsh-pip-user .dsh-pip-text{background:rgba(127,127,127,.14);border-radius:8px;padding:7px 9px;white-space:pre-wrap;word-break:break-word}',
			'.dsh-pip-assistant .dsh-pip-text{word-break:break-word}',
			'.dsh-pip-disclosure{margin:1px 0}',
			'.dsh-pip-reasoning{font-size:.92em;opacity:.6;white-space:pre-wrap;word-break:break-word;padding:2px 0 6px}',
			'.dsh-pip-tool-list{display:flex;flex-direction:column;gap:8px;padding:4px 0 6px}',
			'.dsh-pip-tool{font-size:.92em;opacity:.75}',
			'.dsh-pip-tool-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600}',
			'.dsh-pip-tool-args{margin:2px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.8;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto}',
			'.dsh-pip-tool-error{color:#e5534b}',
			'.dsh-pip-error{color:#e5534b;font-size:12px;white-space:pre-wrap;word-break:break-word}',
			'.dsh-pip-footer{flex:0 0 auto;border-top:1px solid rgba(127,127,127,.25);padding:8px 10px;display:flex;flex-direction:column;gap:6px}',
			'.dsh-pip-composer{display:flex;align-items:flex-end;gap:6px}',
			'.dsh-pip-input{flex:1 1 auto;resize:none;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.08);color:inherit;border-radius:8px;padding:7px 9px;font:inherit;font-size:12px;line-height:1.5;max-height:120px;min-height:34px;outline:none}',
			'.dsh-pip-input:focus{border-color:rgba(127,127,127,.6)}',
			'.dsh-pip-file{display:none}',
			'.dsh-pip-attach{display:flex;flex-wrap:wrap;gap:6px}',
			'.dsh-pip-thumb{position:relative;width:46px;height:46px;border-radius:6px;overflow:hidden;border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.08)}',
			'.dsh-pip-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
			'.dsh-pip-thumb-x{position:absolute;top:1px;right:1px;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border:0;border-radius:50%;padding:0;cursor:pointer;line-height:1;background:rgba(0,0,0,.55);color:#fff}',
			'.dsh-pip-status{flex:0 0 auto;display:flex;align-items:center;gap:6px;font-size:11px;opacity:.65}',
			'.dsh-pip-dot{width:6px;height:6px;border-radius:50%;background:rgba(127,127,127,.6);display:inline-block}',
			'.dsh-pip-dot[data-state="running"]{background:#3fb950}',
			'.dsh-pip-dot[data-state="opening"]{background:#d29922}',
			'.dsh-pip-dot[data-state="error"]{background:#e5534b}',
		].join('\n');

		/* ==================================================================
		 * M2 —— 数据层
		 * ================================================================== */

		function resolveSessions() {
			if (sessionsService) return sessionsService;
			try {
				const got = rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('sessions') : null;
				if (got) sessionsService = got;
			} catch {
				/* 忽略 */
			}
			return sessionsService;
		}

		/**
		 * 当前会话 id。
		 * dsh 的「视图选中会话」不属于 sessions 服务（`ClientSessions` 明写
		 * "view selection remains outside the Controller"），它是 workspace 插件的
		 * 选择状态，经 createSnapshotStore 持久化到 localStorage，key 即
		 * `dsh.sessions.current`。这是目前唯一能读到的权威值。
		 */
		function readCurrentSessionId() {
			try {
				const raw = localStorage.getItem('dsh.sessions.current');
				if (!raw) return null;
				const parsed = JSON.parse(raw);
				const id = parsed && parsed.sessionId;
				return typeof id === 'string' && id ? id : null;
			} catch {
				return null;
			}
		}

		/** 从消息对象的 content 里取纯文本（content 可能是字符串或 block 数组）。 */
		/** 主界面 conversation.encodeImage 只接受这四种浏览器光栅类型。 */
		function isImageMediaType(value) {
			return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif';
		}

		/** 原生 base64 线上形态（FileReader data-URL 去掉前缀），与主界面同构。 */
		function base64ImageOf(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const url = String(reader.result);
					const comma = url.indexOf(',');
					resolve(comma >= 0 ? url.slice(comma + 1) : url);
				};
				reader.onerror = () => reject(reader.error || new Error('pip: image read failed'));
				reader.readAsDataURL(file);
			});
		}

		function contentText(message) {
			if (!message) return '';
			const content = message.content;
			if (typeof content === 'string') return content;
			if (!Array.isArray(content)) return '';
			let out = '';
			for (const block of content) {
				if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
			}
			return out;
		}

		/**
		 * 从 assistant/message 的 stream 里取思考正文。
		 * 流式期间的思考来自 transient（assistant/live-chunk 的 reasoning-delta），
		 * 一旦 attempt 落地，transient 消失，思考就只剩这里 —— 打包记录
		 * `{type:'reasoning-chunks', texts:[...]}`（见 dsh-llm/assistant-stream.d.ts:22-27）。
		 * 不读这里，历史消息的「思考」块就会是空的。
		 */
		function streamReasoning(stream) {
			if (!Array.isArray(stream)) return '';
			let out = '';
			for (const record of stream) {
				if (!record || record.type !== 'reasoning-chunks') continue;
				const texts = record.texts;
				if (!Array.isArray(texts)) continue;
				for (const piece of texts) {
					if (typeof piece === 'string') out += piece;
				}
			}
			return out;
		}

		function shortArgs(raw) {
			if (typeof raw !== 'string') return '';
			const flat = raw.replace(/\s+/g, ' ').trim();
			return flat.length > 160 ? flat.slice(0, 160) + '…' : flat;
		}

		/** 取快照里的标题（列表里没有就是空）。 */
		function sessionTitle(list, sessionId) {
			if (!list || !sessionId) return '';
			const row = list.byId && list.byId[sessionId];
			if (!row) return '';
			return row.displayTitle || row.title || '';
		}

		/**
		 * 工具名 → 人话类别，用来拼出 dsh 那种「已调用工具，已搜索代码…」的汇总标题。
		 */
		const TOOL_KIND_RULES = [
			[/^(read|grep|glob|search|list|ls|find|cat|head|tail|inspect)/i, '搜索代码'],
			[/^(write|edit|apply|patch|create|mkdir|mv|cp|rm|delete)/i, '修改文件'],
			[/^(pwsh|powershell|bash|sh|zsh|shell|exec|run|terminal|cmd)/i, '执行命令'],
			[/^browser/i, '浏览网页'],
			[/^(web|fetch|http|curl|download|upload|request)/i, '联网访问'],
			[/^(task|agent|subagent|delegate)/i, '调用子代理'],
			[/^(skill|mcp)/i, '调用技能'],
		];

		function toolKind(name) {
			const text = String(name || '');
			for (const rule of TOOL_KIND_RULES) {
				if (rule[0].test(text)) return rule[1];
			}
			return '调用工具';
		}

		function toolSummary(items) {
			const kinds = [];
			for (const item of items) {
				const kind = toolKind(item.name);
				if (kinds.indexOf(kind) < 0) kinds.push(kind);
			}
			if (!kinds.length) return '已调用工具';
			return '已' + kinds.join('，');
		}

		/**
		 * 事件窗 → 渲染行。
		 * 每次 change 都全量重建（窗口本身是增量的，重建成本只跟窗口大小有关）。
		 *
		 * 行类型：
		 *   user        用户消息
		 *   assistant   助手消息（可能同时带 text 与 reasoning）
		 *   toolgroup   一段连续的工具调用（折成一行，跟 dsh 一样可展开）
		 *   error       工具失败
		 *
		 * transient（assistant/live-chunk）是流式增量；attempt 落地时
		 * settle-assistant 会把对应 transient 行移除，所以正文不会重复。
		 */
		function buildRows(entries) {
			const rows = [];
			const live = new Map();
			const calls = new Map();
			if (!Array.isArray(entries)) return rows;

			let group = null;
			const closeGroup = () => {
				group = null;
			};

			for (const entry of entries) {
				if (!entry) continue;

				if (entry.type === 'transient') {
					const data = entry.event && entry.event.data;
					const chunk = data && data.chunk;
					if (!chunk) continue;
					// 只有真正带字的 delta 才建行：block-start / usage / finish /
					// tool-call-delta 都会来同一条 transient 通道，照单全收会造出空行。
					const isText = chunk.type === 'text-delta' && typeof chunk.text === 'string';
					const isReasoning = chunk.type === 'reasoning-delta' && typeof chunk.text === 'string';
					if (!isText && !isReasoning) continue;
					closeGroup();
					const key = String(data.attemptId);
					let row = live.get(key);
					if (!row) {
						row = { kind: 'assistant', key: 'live:' + key, text: '', reasoning: '', streaming: true };
						live.set(key, row);
						rows.push(row);
					}
					if (isText) row.text += chunk.text;
					else row.reasoning += chunk.text;
					continue;
				}

				const ev = entry.event;
				const data = ev && ev.data;
				switch (ev && ev.type) {
					case 'user/message': {
						closeGroup();
						const text = contentText(data);
						if (text.trim()) rows.push({ kind: 'user', key: 'u:' + ev.seq, text });
						break;
					}
					case 'assistant/message': {
						closeGroup();
						const text = contentText(data && data.message);
						const reasoning = streamReasoning(data && data.stream);
						if (text.trim() || reasoning.trim()) {
							rows.push({
								kind: 'assistant',
								key: 'a:' + ev.seq,
								text,
								reasoning,
								streaming: false,
								interrupted: Boolean(data && data.interrupted),
							});
						}
						break;
					}
					case 'tool/call': {
						if (!group) {
							group = { kind: 'toolgroup', key: 'g:' + ev.seq, items: [], summary: '', running: false };
							rows.push(group);
						}
						const item = {
							name: (data && data.name) || 'tool',
							args: shortArgs(data && data.arguments),
							callId: data && data.callId ? String(data.callId) : '',
							done: false,
							error: '',
						};
						group.items.push(item);
						if (item.callId) calls.set(item.callId, item);
						break;
					}
					case 'tool/result': {
						const item = data && data.callId ? calls.get(String(data.callId)) : null;
						if (item) {
							item.done = true;
							if (data.error) {
								item.error =
									(data.error.name || '工具失败') +
									(data.error.reason ? ' — ' + data.error.reason : '');
							}
						} else if (data && data.error) {
							closeGroup();
							rows.push({
								kind: 'error',
								key: 'e:' + ev.seq,
								text:
									'工具失败：' +
									(data.error.name || '') +
									(data.error.reason ? ' — ' + data.error.reason : ''),
							});
						}
						break;
					}
					default:
						break;
				}
			}

			for (const row of rows) {
				if (row.kind !== 'toolgroup') continue;
				row.summary = toolSummary(row.items);
				row.running = row.items.some((item) => !item.done);
			}
			return rows;
		}

		/* ==================================================================
		 * M3 —— 视图（可折叠行对标 dsh）
		 * ================================================================== */

		/** 思考块：默认在流式时自动展开，用户点过之后就听用户的。 */
		function ReasoningRow(props) {
			const row = props.row;
			const [manual, setManual] = React.useState(null);
			const streaming = Boolean(row.streaming);
			const open = manual === null ? streaming : manual;
			const onToggle = React.useCallback(() => {
				setManual((prev) => !(prev === null ? streaming : prev));
			}, [streaming]);
			const chars = (row.reasoning || '').length;

			return h(
				DisclosureRow,
				{
					className: 'dsh-pip-disclosure',
					icon: h(IconThink, { size: 14 }),
					title: streaming ? '思考中' : '思考' + (chars ? ' · ' + chars + ' 字' : ''),
					open,
					expandable: true,
					onToggle,
					running: streaming,
					expandOnRowClick: true,
					previewChevron: true,
				},
				h('div', { className: 'dsh-pip-reasoning' }, row.reasoning),
			);
		}

		/** 工具组：一段连续的工具调用折成一行，展开看每个工具的名字与参数。 */
		function ToolGroupRow(props) {
			const row = props.row;
			const [open, setOpen] = React.useState(false);
			const onToggle = React.useCallback(() => setOpen((prev) => !prev), []);
			const count = row.items.length;

			return h(
				DisclosureRow,
				{
					className: 'dsh-pip-disclosure',
					icon: h(IconTool, { size: 14 }),
					title: row.summary + (count > 1 ? ' · ' + count + ' 次' : ''),
					open,
					expandable: true,
					onToggle,
					running: Boolean(row.running),
					expandOnRowClick: true,
					previewChevron: true,
				},
				h(
					'div',
					{ className: 'dsh-pip-tool-list' },
					row.items.map((item, index) =>
						h(
							'div',
							{ key: (item.callId || item.name) + ':' + index, className: 'dsh-pip-tool' },
							h('div', { className: 'dsh-pip-tool-name' }, item.name),
							item.args ? h('pre', { className: 'dsh-pip-tool-args' }, item.args) : null,
							item.error ? h('div', { className: 'dsh-pip-tool-error' }, item.error) : null,
						),
					),
				),
			);
		}

		function RoleLabel(props) {
			return h('div', { className: 'dsh-pip-role' }, props.children);
		}

		function MessageRow(props) {
			const row = props.row;
			if (row.kind === 'toolgroup') return h(ToolGroupRow, { row });
			if (row.kind === 'error') return h('div', { className: 'dsh-pip-error' }, row.text);

			const isUser = row.kind === 'user';
			const children = [];
			children.push(h(RoleLabel, { key: 'role' }, isUser ? '你' : row.streaming ? '助手 · 生成中' : '助手'));
			if (!isUser && row.reasoning) {
				children.push(h(ReasoningRow, { key: 'reasoning', row }));
			}
			if (row.text && row.text.trim()) {
				children.push(
					h(
						'div',
						{ key: 'text', className: 'dsh-pip-text' },
						isUser
							? row.text
							: h(MarkdownText, {
									text: row.text,
									streaming: Boolean(row.streaming),
									labels: MD_LABELS,
									// 对标 dsh 主界面：用完整文档排版，不是 compact 的次级排版
									variant: 'body',
								}),
					),
				);
			}
			if (row.interrupted) children.push(h(RoleLabel, { key: 'int' }, '已中断'));
			return h('div', { className: 'dsh-pip-row ' + (isUser ? 'dsh-pip-user' : 'dsh-pip-assistant') }, children);
		}

		function PipShell() {
			const [sessionId, setSessionId] = React.useState(() => readCurrentSessionId());
			const [eventWindow, setEventWindow] = React.useState(null);
			const [sessionSnap, setSessionSnap] = React.useState(null);
			const [listSnap, setListSnap] = React.useState(null);
			const [phase, setPhase] = React.useState('opening');
			const [error, setError] = React.useState(null);
			const [draft, setDraft] = React.useState('');
			const [images, setImages] = React.useState([]);
			const [busy, setBusy] = React.useState(false);

			const bindingRef = React.useRef(null);
			const bodyRef = React.useRef(null);
			const inputRef = React.useRef(null);
			const fileRef = React.useRef(null);

			// 跟随主视图：localStorage 不会在同 tab 内发变更事件，1s 读一次
			// （一次 JSON.parse，开销可忽略；比 hud-bar 的 HTTP 轮询轻两个数量级）。
			React.useEffect(() => {
				const timer = setInterval(() => {
					const next = readCurrentSessionId();
					setSessionId((prev) => (next && next !== prev ? next : prev));
				}, 1000);
				return () => clearInterval(timer);
			}, []);

			// 订阅：会话事件窗 + 会话快照 + 会话列表（标题）
			React.useEffect(() => {
				setEventWindow(null);
				setSessionSnap(null);
				setError(null);
				bindingRef.current = null;

				const sessions = resolveSessions();
				if (!sessions) {
					setPhase('no-service');
					warn('sessions service unavailable — 数据层无法启动');
					return undefined;
				}
				if (!sessionId) {
					setPhase('no-session');
					return undefined;
				}

				setPhase('opening');
				let reference = null;
				try {
					reference = sessions.retain(sessionId, { source: 'pipWindow' });
				} catch (err) {
					setPhase('error');
					setError('retain 失败：' + String((err && err.message) || err));
					return undefined;
				}

				let cancelled = false;
				let unsubEvents = null;
				let unsubSession = null;
				let unsubList = null;

				const attachBinding = (binding) => {
					bindingRef.current = binding;
					const source = binding.eventSource;
					const publishEvents = () => {
						const snapshot = source.getSnapshot();
						setEventWindow(snapshot);
					};
					publishEvents();
					unsubEvents = source.subscribe(publishEvents);

					if (binding.session && typeof binding.session.subscribe === 'function') {
						const publishSession = () => setSessionSnap(binding.session.getSnapshot());
						publishSession();
						unsubSession = binding.session.subscribe(publishSession);
					}

					if (sessions.list && typeof sessions.list.subscribe === 'function') {
						const publishList = () => setListSnap(sessions.list.getSnapshot());
						publishList();
						unsubList = sessions.list.subscribe(publishList);
					}

					setPhase('ready');
					const window0 = source.getSnapshot();
					dlog(
						'event window attached ' +
							JSON.stringify({
								sessionId,
								revision: window0 && window0.revision,
								entries: window0 && window0.entries ? window0.entries.length : 0,
								hasMore: window0 && window0.hasMore,
							}),
					);
				};

				let ready = null;
				try {
					ready = reference.ready;
				} catch {
					ready = null;
				}
				Promise.resolve(ready)
					.then((binding) => {
						if (cancelled) return;
						if (!binding) throw new Error('reference.ready 未返回 binding');
						attachBinding(binding);
					})
					.catch((err) => {
						if (cancelled) return;
						setPhase('error');
						setError('会话打开失败：' + String((err && err.message) || err));
						warn('retain ready failed', err);
					});

				return () => {
					cancelled = true;
					if (unsubEvents) unsubEvents();
					if (unsubSession) unsubSession();
					if (unsubList) unsubList();
					bindingRef.current = null;
					try {
						if (reference && typeof reference.release === 'function') reference.release();
					} catch (err) {
						warn('release failed', err);
					}
				};
			}, [sessionId]);

			const rows = React.useMemo(
				() => buildRows(eventWindow && eventWindow.entries),
				[eventWindow],
			);

			// 新内容到达时贴底
			const tailKey = rows.length ? rows[rows.length - 1].key + ':' + (rows[rows.length - 1].text || '').length : '';
			React.useEffect(() => {
				const body = bodyRef.current;
				if (body) body.scrollTop = body.scrollHeight;
			}, [tailKey]);

			const running = Boolean(sessionSnap && sessionSnap.running);
			const title = sessionTitle(listSnap, sessionId) || (sessionId ? sessionId.slice(0, 18) : '未选择会话');

			// 诊断：PiP 是另一个 document，主 tab 的 devtools 看不到它渲染了什么，
			// 所以把行数/末行摘要打到 console（节流 400ms，避免每个 chunk 一条）。
			// 默认关闭：localStorage['dsh-pip-window:debug']='1' 打开。
			const lastLogRef = React.useRef(0);
			React.useEffect(() => {
				if (!DEBUG) return undefined;
				const now = Date.now();
				if (now - lastLogRef.current < 400) return undefined;
				lastLogRef.current = now;
				const last = rows.length ? rows[rows.length - 1] : null;
				log(
					'pip rows ' +
						JSON.stringify({
							count: rows.length,
							phase,
							running,
							last: last
								? {
										kind: last.kind,
										chars: (last.text || '').length,
										reasoningChars: (last.reasoning || '').length,
										items: last.items ? last.items.length : undefined,
										streaming: Boolean(last.streaming),
									}
								: null,
						}),
				);
				return undefined;
			}, [rows, phase, running]);

			// 诊断：ready 后连续探几次 PiP 真实 DOM，确认不是"日志好看但没渲染"。
			React.useEffect(() => {
				if (!DEBUG || phase !== 'ready') return undefined;
				let probes = 0;
				const probe = () => {
					try {
						const doc = pipWindow && pipWindow.document;
						if (!doc) return;
						log(
							'pip dom ' +
								JSON.stringify({
									shell: Boolean(doc.querySelector('.dsh-pip-shell')),
									rows: doc.querySelectorAll('.dsh-pip-row').length,
									texts: doc.querySelectorAll('.dsh-pip-text').length,
									reasonings: doc.querySelectorAll('.dsh-pip-reasoning').length,
									disclosures: doc.querySelectorAll('.dsh-pip-disclosure').length,
									buttons: Array.from(doc.querySelectorAll('.dsh-pip-btn')).map(
										(el) => el.getAttribute('aria-label') || el.getAttribute('title') || '',
									),
									fileInput: doc.querySelectorAll('input[type="file"]').length,
									svgs: doc.querySelectorAll('svg').length,
									tail: (doc.body.innerText || '').replace(/\s+/g, ' ').slice(-220),
								}),
						);
					} catch (err) {
						warn('pip dom probe failed', err);
					}
				};
				const first = setTimeout(probe, 700);
				const timer = setInterval(() => {
					probes += 1;
					if (probes > 7) {
						clearInterval(timer);
						return;
					}
					probe();
				}, 2200);
				return () => {
					clearTimeout(first);
					clearInterval(timer);
				};
			}, [phase]);

			const addImages = React.useCallback((files) => {
				const accepted = [];
				for (const file of files || []) {
					if (!file || !isImageMediaType(file.type)) continue;
					accepted.push({
						id: 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
						file,
						url: URL.createObjectURL(file),
						name: file.name || '',
						mediaType: file.type,
					});
				}
				if (accepted.length === 0) return;
				setImages((prev) => prev.concat(accepted));
			}, []);

			const removeImage = React.useCallback((id) => {
				setImages((prev) => {
					const found = prev.find((item) => item.id === id);
					if (found) URL.revokeObjectURL(found.url);
					return prev.filter((item) => item.id !== id);
				});
			}, []);

			const clearImages = React.useCallback(() => {
				setImages((prev) => {
					for (const item of prev) URL.revokeObjectURL(item.url);
					return [];
				});
			}, []);

			const pickImages = React.useCallback(() => {
				const input = fileRef.current;
				if (input) input.click();
			}, []);

			/** 粘贴板里的图片直接进附件栏。 */
			const onPaste = React.useCallback(
				(event) => {
					const data = event.clipboardData;
					if (!data) return;
					const files = [];
					for (const item of data.items || []) {
						if (item.kind !== 'file') continue;
						const file = item.getAsFile();
						if (file && isImageMediaType(file.type)) files.push(file);
					}
					if (files.length === 0) return;
					event.preventDefault();
					addImages(files);
				},
				[addImages],
			);

			const send = React.useCallback(async () => {
				const text = draft.trim();
				const binding = bindingRef.current;
				if ((!text && images.length === 0) || !binding) return;
				setBusy(true);
				setError(null);
				try {
					// 顺序与主界面 sendSession 一致：附件在前，文本在后。
					const parts = [];
					for (const item of images) {
						parts.push({
							type: 'image',
							mediaType: item.mediaType,
							data: await base64ImageOf(item.file),
							...(item.name ? { name: item.name } : {}),
						});
					}
					if (text) parts.push({ type: 'text', text });
					const result = await binding.session.prompt(parts, 'queue');
					if (result && result.ok === false) {
						setError('发送被拒：' + JSON.stringify(result.error || result));
					} else {
						setDraft('');
						clearImages();
					}
				} catch (err) {
					setError('发送异常：' + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			}, [draft, images, clearImages]);

			const stop = React.useCallback(async () => {
				const binding = bindingRef.current;
				if (!binding) return;
				setBusy(true);
				try {
					await binding.session.cancel();
				} catch (err) {
					setError('停止异常：' + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			}, []);

			const onKeyDown = React.useCallback(
				(event) => {
					if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
						event.preventDefault();
						send();
					}
				},
				[send],
			);

			const placeholder = !sessionId
				? '没有检测到当前会话。先在主窗口打开一个会话，这里会自动跟上。'
				: phase === 'opening'
					? '正在打开会话…'
					: phase === 'no-service'
						? 'sessions 服务尚未就绪。'
						: null;

			const body = placeholder
				? h('div', { className: 'dsh-pip-placeholder' }, placeholder)
				: rows.length === 0
					? h('div', { className: 'dsh-pip-placeholder' }, '这个会话还没有消息。在下面输入试试。')
					: rows.map((row) => h(MessageRow, { key: row.key, row }));

			return h(
				'div',
				{ className: 'dsh-pip-shell' },
				h(
					'div',
					{ className: 'dsh-pip-header' },
					h(IconPipWindow, { size: 14 }),
					h('div', { className: 'dsh-pip-title', title }, title),
					h('div', { className: 'dsh-pip-meta' }, running ? '运行中' : '空闲'),
				),
				h('div', { className: 'dsh-pip-body', ref: bodyRef }, body, error ? h('div', { className: 'dsh-pip-error' }, error) : null),
				h(
					'div',
					{ className: 'dsh-pip-footer' },
					images.length > 0
						? h(
								'div',
								{ className: 'dsh-pip-attach' },
								images.map((item) =>
									h(
										'div',
										{ className: 'dsh-pip-thumb', key: item.id, title: item.name },
										h('img', { src: item.url, alt: item.name || '待发送图片' }),
										h(
											'button',
											{
												className: 'dsh-pip-thumb-x',
												type: 'button',
												title: '移除',
												'aria-label': '移除图片',
												onClick: () => removeImage(item.id),
											},
											h(IconClose, { size: 11 }),
										),
									),
								),
							)
						: null,
					h(
						'div',
						{ className: 'dsh-pip-composer' },
						h('input', {
							ref: fileRef,
							className: 'dsh-pip-file',
							type: 'file',
							accept: 'image/png,image/jpeg,image/webp,image/gif',
							multiple: true,
							onChange: (event) => {
								addImages(Array.from(event.target.files || []));
								event.target.value = '';
							},
						}),
						h(
							'button',
							{
								className: 'dsh-pip-btn',
								type: 'button',
								title: '发送图片',
								'aria-label': '发送图片',
								onClick: pickImages,
								disabled: busy || !sessionId || phase !== 'ready',
							},
							h(IconPaperclip, { size: 16 }),
						),
						h('textarea', {
							ref: inputRef,
							className: 'dsh-pip-input',
							placeholder: sessionId ? '输入消息，Enter 发送，Shift+Enter 换行，可粘贴图片' : '等待会话…',
							value: draft,
							disabled: !sessionId || phase !== 'ready',
							onChange: (event) => setDraft(event.target.value),
							onKeyDown,
							onPaste,
							rows: 1,
						}),
						running
							? h(
									'button',
									{ className: 'dsh-pip-btn', title: '停止生成', onClick: stop, disabled: busy },
									h(IconStop, { size: 16 }),
								)
							: h(
									'button',
									{
										className: 'dsh-pip-btn',
										title: '发送',
										onClick: send,
										disabled: busy || (!draft.trim() && images.length === 0) || !sessionId || phase !== 'ready',
									},
									h(IconSend, { size: 16 }),
								),
					),
					h(
						'div',
						{ className: 'dsh-pip-status' },
						h('span', { className: 'dsh-pip-dot', 'data-state': running ? 'running' : phase }),
						h('span', null, rows.length + ' 行'),
						eventWindow && eventWindow.hasMore ? h('span', null, '· 更早的历史未加载') : null,
						h('span', { style: { flex: '1 1 auto' } }),
						eventWindow ? h('span', null, 'rev ' + eventWindow.revision) : null,
					),
				),
			);
		}

		/* ==================================================================
		 * 窗口开合
		 * ================================================================== */

		let pipWindow = null;
		let pipRoot = null;

		function openPipWindow() {
			if (pipWindow && !pipWindow.closed) {
				try {
					pipWindow.focus();
				} catch {
					/* 忽略 */
				}
				return Promise.resolve(pipWindow);
			}

			// requestWindow 必须在用户手势的 transient activation 内**同步**发起，
			// 且它返回 Promise<Window> 而不是 Window —— 搬运要等它 resolve。
			const requesting = window.documentPictureInPicture.requestWindow({ width: 420, height: 620 });

			return Promise.resolve(requesting).then((win) => {
				pipWindow = win;

				const mirrored = mirrorDocument(pipWindow.document);
				log('document mirrored ' + JSON.stringify(mirrored));

				const style = pipWindow.document.createElement('style');
				style.setAttribute('data-plugin', 'dsh-pip-window');
				style.textContent = PIP_CSS;
				pipWindow.document.head.appendChild(style);

				const container = pipWindow.document.createElement('div');
				container.id = 'dsh-pip-root';
				pipWindow.document.body.appendChild(container);

				pipRoot = ReactDOMClient.createRoot(container);
				pipRoot.render(h(PipShell, null));

				log(
					'pip window opened ' +
						JSON.stringify({
							size: { width: 420, height: 620 },
							mainTokens: probeTokens(document),
							pipTokens: probeTokens(pipWindow.document),
						}),
				);

				pipWindow.addEventListener('pagehide', () => {
					try {
						if (pipRoot) pipRoot.unmount();
					} catch {
						/* 忽略 */
					}
					pipRoot = null;
					pipWindow = null;
					log('pip window closed');
				});

				return win;
			});
		}

		/* ==================================================================
		 * M0 —— 契约自检件 + 入口
		 * ================================================================== */

		function PipWindowButton() {
			const [open, setOpen] = React.useState(false);

			const onClick = React.useCallback(() => {
				log('slot button clicked ' + JSON.stringify({ hasDocumentPiP: 'documentPictureInPicture' in window }));
				if (pipWindow && !pipWindow.closed) {
					try {
						pipWindow.focus();
					} catch {
						/* 忽略 */
					}
					return;
				}
				try {
					// requestWindow 必须在用户手势的 transient activation 内同步发起
					const pending = openPipWindow();
					setOpen(true);
					if (pending && typeof pending.catch === 'function') {
						pending.catch((err) => warn('pip open failed', err));
					}
				} catch (err) {
					warn('requestWindow failed', err);
				}
			}, []);

			// 窗口自己关掉时把按钮状态收回来
			React.useEffect(() => {
				const timer = setInterval(() => {
					const isOpen = Boolean(pipWindow && !pipWindow.closed);
					setOpen((prev) => (prev !== isOpen ? isOpen : prev));
				}, 500);
				return () => clearInterval(timer);
			}, []);

			// 侧边栏收起时靠 CSS 的 [data-sidebar-collapsed] 祖先选择器切成 36×36 纯图标，
			// 不需要 JS 参与（那个属性挂在 AppFrame 上，是本按钮的祖先）。

			return h(
				'button',
				{
					type: 'button',
					className: 'dsh-pip-trigger',
					title: '置顶小窗',
					'aria-label': '置顶小窗',
					'aria-pressed': open,
					onClick,
				},
				h(IconPipWindow, { size: 18, strokeWidth: 1.3, key: 'icon' }),
				h('span', { className: 'dsh-pip-trigger-label', key: 'label' }, '小窗'),
			);
		}

		log('client bundle materialized (factory ran)', { hasDocumentPiP: typeof window !== 'undefined' && 'documentPictureInPicture' in window });

		return {
			inject: ['slots'],
			apply(ctx) {
				rootCtx = ctx;
				log('client half applied', Object.keys(ctx));
				ensureTriggerStyle();
				try {
					ctx.inject(['sessions'], (scope) => {
						sessionsService = scope.sessions || null;
						log('sessions service acquired ' + JSON.stringify({ ok: Boolean(sessionsService) }));
					});
				} catch (err) {
					warn('sessions inject failed', err);
				}
				ctx.slots.inject('sidebar.footer.action', () =>
					ctx.slots.register({ name: 'sidebar.footer.action', id: 'pip-window', order: 100 }, PipWindowButton),
				);
				log('registered into sidebar.footer.action');
			},
		};
	},
});
