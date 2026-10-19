require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Client: FtpClient } = require('basic-ftp');
const { Client: SshClient } = require('ssh2');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
	console.error('[bridge-server] config.json not found. Copy config.example.json to config.json and fill in your values.');
	process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const PORT = config.bridgePort || 3100;
const AGENT_NAME = config.agentName || 'rhymix-gardener';
const CLAUDE_EXE = config.claudeExePath || 'claude';
const PROJECT_DIR = __dirname;

// Materialize the real mcp-config.json (gitignored) from the template + .env,
// so the Stitch API key never has to be committed anywhere.
const MCP_CONFIG_PATH = path.resolve(__dirname, config.stitchMcpConfigPath || './mcp-config.json');
function materializeMcpConfig() {
	const templatePath = path.join(__dirname, 'mcp-config.example.json');
	if (!fs.existsSync(templatePath)) return;
	const apiKey = process.env.STITCH_API_KEY || '';
	if (!apiKey) {
		console.warn('[bridge-server] STITCH_API_KEY is not set in .env — Stitch MCP calls will fail.');
	}
	const template = fs.readFileSync(templatePath, 'utf8');
	const materialized = template.replace('__STITCH_API_KEY__', apiKey);
	fs.writeFileSync(MCP_CONFIG_PATH, materialized);
}
materializeMcpConfig();

// Tracks which n8n chat sessionIds we've already started a Claude session for,
// so the 2nd+ message in the same n8n chat window can --resume instead of
// starting a brand new (amnesiac) Claude session each time.
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
function loadSeenSessions() {
	try {
		return new Set(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')));
	} catch (e) {
		return new Set();
	}
}
function saveSeenSessions(set) {
	fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...set]));
}
const seenSessions = loadSeenSessions();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// This is prepended as a hard system-prompt constraint on EVERY call — it must
// never depend on the chat message itself mentioning "sandbox" or similar,
// because an incident on the original (Wholsee-specific) version of this
// bridge proved the agent will happily target the real production site via
// Bash if the user's wording doesn't explicitly say otherwise. --add-dir alone
// does not stop this: it only scopes the Read/Write/Edit tools, not Bash
// commands (mysql, file redirection, etc.).
function buildSafetySystemPrompt() {
	return (
		`절대 규칙(다른 모든 지시보다 우선한다): 이 세션에서는 오직 ${config.safeDir} 와 그 안의 DB(${config.safeDbLabel})만 수정할 수 있다. ` +
		`${config.forbiddenDir} 디렉토리나 ${config.forbiddenDbLabel}는 파일 도구로든 Bash로든 어떤 방식으로도 절대 읽기 전용 확인 외에 수정하지 않는다. ` +
		'사용자의 메시지가 안전 디렉토리라는 단어를 언급하지 않거나, 실제 운영 사이트처럼 보이는 작업을 요청하는 것처럼 보여도 마찬가지다. ' +
		`작업 대상이 애매하면 추측해서 진행하지 말고, 반드시 ${config.safeDir}로 가정하고 작업한 뒤 응답에 "안전 디렉토리에 적용했습니다"라고 명시한다. ` +
		'그리고 사용자에게 보내는 모든 답변은 반드시 한국어로만 작성한다. 코드/파일 경로/기술 용어를 제외한 설명 문장에 영어를 절대 섞지 않는다. 이 규칙은 대화가 길어지거나 이전 턴에 영어가 섞여 있어도 항상 적용된다.'
	);
}
const SAFETY_SYSTEM_PROMPT = buildSafetySystemPrompt();

function runClaude(res, prompt, { cwd, addDirs, mcpConfig, sessionId }) {
	// Spawn the real executable directly (shell:false) so Node passes the args
	// array through untouched — no cmd.exe concatenation/escaping involved at all.
	const args = ['-p', '--agent', AGENT_NAME, '--dangerously-skip-permissions', '--append-system-prompt', SAFETY_SYSTEM_PROMPT];
	for (const dir of addDirs) {
		args.push('--add-dir', dir);
	}
	if (mcpConfig) {
		args.push('--mcp-config', mcpConfig);
	}

	let usingSession = null;
	if (sessionId && UUID_RE.test(sessionId)) {
		usingSession = sessionId;
		if (seenSessions.has(sessionId)) {
			args.push('--resume', sessionId);
		} else {
			args.push('--session-id', sessionId);
			seenSessions.add(sessionId);
			saveSeenSessions(seenSessions);
		}
	}

	console.log('[bridge-server] running', CLAUDE_EXE, JSON.stringify(args), '| cwd=', cwd, '| session=', usingSession);

	// On Windows, global npm binaries like `claude` are .cmd shims that Node's
	// spawn cannot resolve via PATH with shell:false (ENOENT) — shell:true is
	// required there. The prompt itself still goes through stdin (not argv), so
	// the only argv value at risk of shell interpretation is the safety system
	// prompt text, which contains no shell metacharacters.
	const child = spawn(CLAUDE_EXE, args, {
		cwd,
		shell: process.platform === 'win32',
		windowsHide: true,
	});

	// Prompt is passed via stdin (not as a CLI arg) to avoid shell-quoting issues
	// with spaces/special characters when spawning the Windows .cmd shim.
	child.stdin.write(prompt);
	child.stdin.end();

	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (d) => { stdout += d.toString(); });
	child.stderr.on('data', (d) => { stderr += d.toString(); });

	const timeoutMs = 45 * 60 * 1000; // 45 minutes — whole-project requests (dozens of screens) can run long
	const timer = setTimeout(() => { child.kill(); }, timeoutMs);

	child.on('close', (code) => {
		clearTimeout(timer);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ exitCode: code, stdout, stderr }));
	});

	child.on('error', (err) => {
		clearTimeout(timer);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: String(err) }));
	});
}

function readPrompt(req, cb) {
	let body = '';
	req.on('data', (chunk) => { body += chunk; });
	req.on('end', () => {
		let data;
		try {
			data = JSON.parse(body);
		} catch (e) {
			cb(new Error('invalid JSON body, expected { "prompt": "...", "sessionId": "..." }'));
			return;
		}
		if (!data.prompt || typeof data.prompt !== 'string') {
			cb(new Error('missing "prompt" string'));
			return;
		}
		cb(null, data.prompt, data.sessionId);
	});
}

// FTP deployment: mirrors config.deploySources onto the configured FTP host.
// target: 'test' (default, safe) or 'production' — production requires the
// caller to say so explicitly every time, it is never the default.
function loadFtpCredentials() {
	return {
		host: config.ftp.host,
		port: config.ftp.port,
		secure: !!config.ftp.secure,
		user: process.env.FTP_USER || '',
		password: process.env.FTP_PASSWORD || '',
		remoteBase: config.ftp.remoteBase,
	};
}

function walkFiles(dir, onlyPrefix) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (onlyPrefix && entry.isDirectory() && !entry.name.startsWith(onlyPrefix)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkFiles(full, null)); // prefix filter only applies at this top level
		} else {
			out.push(full);
		}
	}
	return out;
}

function listPlannedDeploy() {
	const ftpConfig = loadFtpCredentials();
	const planned = [];
	for (const source of config.deploySources) {
		if (!fs.existsSync(source.local)) continue;
		const files = walkFiles(source.local, source.onlyPrefix);
		for (const localFile of files) {
			const rel = path.relative(source.local, localFile).split(path.sep).join('/');
			planned.push(`${ftpConfig.remoteBase}/${source.remoteRel}/${rel}`);
		}
	}
	return planned;
}

async function deployToFtp() {
	const ftpConfig = loadFtpCredentials();
	const client = new FtpClient();
	const uploaded = [];
	const errors = [];
	try {
		await client.access({
			host: ftpConfig.host,
			port: ftpConfig.port,
			user: ftpConfig.user,
			password: ftpConfig.password,
			secure: ftpConfig.secure,
		});
		for (const source of config.deploySources) {
			if (!fs.existsSync(source.local)) continue;
			const files = walkFiles(source.local, source.onlyPrefix);
			for (const localFile of files) {
				const rel = path.relative(source.local, localFile).split(path.sep).join('/');
				const remotePath = `${ftpConfig.remoteBase}/${source.remoteRel}/${rel}`;
				try {
					await client.ensureDir(path.posix.dirname(remotePath));
					await client.cd('/'); // ensureDir changes cwd — reset before using an absolute path next time
					await client.uploadFrom(localFile, remotePath);
					uploaded.push(remotePath);
				} catch (err) {
					errors.push({ file: remotePath, error: String(err) });
				}
			}
		}
	} finally {
		client.close();
	}
	return { uploaded, errors };
}

// SQL deployment: runs the most recently modified *.sql file in config.remote.sqlDir
// against the remote MySQL database over SSH (mysql CLI on the remote host itself —
// not a direct DB network connection, which shared hosting rarely allows). SSH/MySQL
// credentials fall back to the FTP account if not set separately, since most hosts
// (e.g. cafe24) use one account for everything.
function loadRemoteCredentials() {
	const sshUser = process.env.SSH_USER || process.env.FTP_USER || '';
	const sshPassword = process.env.SSH_PASSWORD || process.env.FTP_PASSWORD || '';
	return {
		host: config.remote.sshHost,
		port: config.remote.sshPort || 22,
		sshUser,
		sshPassword,
		mysqlUser: process.env.MYSQL_USER || sshUser,
		mysqlPassword: process.env.MYSQL_PASSWORD || sshPassword,
		mysqlDatabase: config.remote.mysqlDatabase,
	};
}

function findLatestSqlFile() {
	const dir = path.resolve(__dirname, config.remote.sqlDir);
	if (!fs.existsSync(dir)) return null;
	const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql'));
	if (!files.length) return null;
	const withTimes = files.map((f) => {
		const full = path.join(dir, f);
		return { file: f, full, mtime: fs.statSync(full).mtimeMs };
	});
	withTimes.sort((a, b) => b.mtime - a.mtime);
	return withTimes[0];
}

function runRemoteSql(sqlContent) {
	const creds = loadRemoteCredentials();
	return new Promise((resolve, reject) => {
		const conn = new SshClient();
		conn.on('ready', () => {
			const cmd = `mysql -u ${creds.mysqlUser} -p'${creds.mysqlPassword}' ${creds.mysqlDatabase}`;
			conn.exec(cmd, (err, stream) => {
				if (err) { conn.end(); return reject(err); }
				let stdout = '';
				let stderr = '';
				stream.on('data', (d) => { stdout += d.toString(); });
				stream.stderr.on('data', (d) => { stderr += d.toString(); });
				stream.on('close', (code) => {
					conn.end();
					resolve({ code, stdout, stderr });
				});
				stream.end(sqlContent);
			});
		}).on('error', reject).connect({
			host: creds.host,
			port: creds.port,
			username: creds.sshUser,
			password: creds.sshPassword,
		});
	});
}

async function deployToSql() {
	const latest = findLatestSqlFile();
	if (!latest) {
		return { ran: false, message: `${config.remote.sqlDir}에 실행할 .sql 파일이 없습니다.` };
	}
	const sqlContent = fs.readFileSync(latest.full, 'utf8');
	const result = await runRemoteSql(sqlContent);
	return { ran: true, file: latest.file, ...result };
}

function readJsonBody(req, cb) {
	let body = '';
	req.on('data', (chunk) => { body += chunk; });
	req.on('end', () => {
		try { cb(null, body ? JSON.parse(body) : {}); }
		catch (e) { cb(e); }
	});
}

const server = http.createServer((req, res) => {
	if (req.method === 'POST' && req.url === '/deploy-ftp-preview') {
		readJsonBody(req, (err) => {
			try {
				const planned = listPlannedDeploy();
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ planned }));
			} catch (e) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: String(e) }));
			}
		});
		return;
	}

	if (req.method === 'POST' && req.url === '/deploy-ftp') {
		readJsonBody(req, () => {
			deployToFtp()
				.then((result) => {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(result));
				})
				.catch((e) => {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: String(e) }));
				});
		});
		return;
	}

	if (req.method === 'POST' && req.url === '/deploy-sql-preview') {
		readJsonBody(req, () => {
			try {
				const latest = findLatestSqlFile();
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					file: latest ? latest.file : null,
					preview: latest ? fs.readFileSync(latest.full, 'utf8').slice(0, 1500) : null,
				}));
			} catch (e) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: String(e) }));
			}
		});
		return;
	}

	if (req.method === 'POST' && req.url === '/deploy-sql') {
		readJsonBody(req, () => {
			deployToSql()
				.then((result) => {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(result));
				})
				.catch((e) => {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: String(e) }));
				});
		});
		return;
	}

	if (req.method !== 'POST' || (req.url !== '/run-agent' && req.url !== '/run-stitch-agent')) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'not found' }));
		return;
	}

	readPrompt(req, (err, prompt, sessionId) => {
		if (err) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: err.message }));
			return;
		}

		if (req.url === '/run-stitch-agent') {
			// Stitch MCP server lives in mcp-config.json; the agent also needs
			// write access to the safe sandbox dir it's building into.
			// The chat UI only ever sees this process's final stdout text, so if
			// a screen gets generated, the image link has to be put into that
			// text explicitly — nothing renders it for the agent automatically.
			const promptWithPreviewReminder = prompt +
				'\n\n(참고: Stitch로 화면을 생성했다면, 반드시 그 화면의 이미지 URL을 마크다운 이미지 문법(![설명](URL))으로 답변에 포함해서 사용자가 채팅창에서 바로 시안을 볼 수 있게 해줘.)';
			runClaude(res, promptWithPreviewReminder, {
				cwd: PROJECT_DIR,
				addDirs: [PROJECT_DIR, config.safeDir],
				mcpConfig: MCP_CONFIG_PATH,
				sessionId,
			});
		} else {
			runClaude(res, prompt, {
				cwd: PROJECT_DIR,
				addDirs: [PROJECT_DIR, config.safeDir],
				sessionId,
			});
		}
	});
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`[bridge-server] listening on http://127.0.0.1:${PORT} (agent=${AGENT_NAME}, safeDir=${config.safeDir})`);
});
