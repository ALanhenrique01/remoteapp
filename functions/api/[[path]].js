const SESSION_DAYS = 30;
const PASSWORD_ITERATIONS = 100_000;

const defaultServices = [
  ["Design Personalizado", "Mapeamento facial com paquímetro e alinhamento geométrico perfeito para o seu rosto.", 45, 35],
  ["Design com Henna", "Design sob medida + aplicação de henna com tonalidade e degradê natural para preenchimento de falhas.", 65, 50],
  ["Brow Lamination", "Técnica de alinhamento dos fios naturais para um efeito volumoso, alinhado e moderno com nutrição profunda.", 110, 60],
  ["Design + Coloração em Gel", "Pigmentação especial em gel com longa fixação nos fios e acabamento leve e sofisticado.", 75, 45],
  ["Micropigmentação Shadow / Nanoblading", "Técnica semi-permanente hiper-realista com nano agulhas para sobrancelhas impecáveis até 1 ano.", 380, 120],
  ["Spa e Nutrição de Sobrancelhas", "Argiloterapia, esfoliação suave, hidratação com óleos nobres e massagem relaxante nos folículos.", 55, 40],
];

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    },
  });
}

function now() {
  return new Date().toISOString();
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function hashPassword(password) {
  const salt = randomHex(16);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: PASSWORD_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2$${salt}$${bytesToHex(bits)}`;
}

async function verifyPassword(password, stored) {
  if (stored.startsWith("pbkdf2$")) {
    const [, salt, expected] = stored.split("$");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: PASSWORD_ITERATIONS },
      key,
      256,
    );
    return constantTimeEqual(bytesToHex(bits), expected);
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  return constantTimeEqual(bytesToHex(digest), stored);
}

async function bootstrap(env) {
  const db = env.DB;
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `).run();

  const admin = await db.prepare("SELECT id FROM users WHERE username = 'admin'").first();
  if (!admin) {
    if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) {
      throw new ApiError(503, "Configure o secret ADMIN_PASSWORD com pelo menos 12 caracteres no Cloudflare Pages.");
    }
    await db.prepare(`
      INSERT INTO users (username, name, phone, password_hash, role, created_at)
      SELECT 'admin', 'Ana Carolina (Designer & Supervisora)', ?, ?, 'supervisor', ?
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin')
    `).bind(env.ADMIN_PHONE || "", await hashPassword(env.ADMIN_PASSWORD), now()).run();
  }

  const count = await db.prepare("SELECT COUNT(*) AS total FROM services").first();
  if (count.total === 0) {
    await db.batch(defaultServices.map(([name, description, price, duration]) =>
      db.prepare("INSERT INTO services (name, description, price, duration_minutes) VALUES (?, ?, ?, ?)")
        .bind(name, description, price, duration)));
  }
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "Corpo da requisição JSON inválido.");
  }
}

async function currentUser(request, db) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    throw new ApiError(401, "Não autorizado. Faça login primeiro.");
  }
  const token = authorization.slice(7);
  const cutoff = new Date(Date.now() - SESSION_DAYS * 86_400_000).toISOString();
  const user = await db.prepare(`
    SELECT u.id, u.username, u.name, u.phone, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.created_at >= ?
  `).bind(token, cutoff).first();
  if (!user) throw new ApiError(401, "Sessão expirada ou inválida.");
  return user;
}

async function supervisor(request, db) {
  const user = await currentUser(request, db);
  if (user.role !== "supervisor") throw new ApiError(403, "Acesso exclusivo para supervisores.");
  return user;
}

async function rows(statement) {
  return (await statement.all()).results;
}

function requireText(value, message) {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(400, message);
  return value.trim();
}

function validateInstagramUrl(value) {
  const instagramUrl = String(value || "").trim();
  if (!instagramUrl) return "";
  if (instagramUrl.length > 2048) throw new ApiError(400, "Informe um link HTTPS válido do Instagram.");
  let url;
  try {
    url = new URL(instagramUrl);
  } catch {
    throw new ApiError(400, "Informe um link HTTPS válido do Instagram.");
  }
  if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname) ||
      url.username || url.password) {
    throw new ApiError(400, "Informe um link HTTPS válido do Instagram.");
  }
  return instagramUrl;
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(400, "Identificador inválido.");
  return id;
}

function validateService(data) {
  if (!data || typeof data.name !== "string" || !data.name.trim()) {
    throw new ApiError(400, "Nome do serviço é obrigatório.");
  }
  if (!Number.isFinite(Number(data.price)) || Number(data.price) < 0 ||
      !Number.isInteger(Number(data.duration_minutes)) || Number(data.duration_minutes) <= 0) {
    throw new ApiError(400, "Valor e duração devem ser válidos.");
  }
}

function validateDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

async function upsertSchedules(db, dates, times) {
  const timestamp = now();
  const statements = [];
  for (const date of dates) {
    for (const rawTime of times) {
      const time = String(rawTime).trim();
      if (time) {
        statements.push(db.prepare(`
          INSERT INTO schedules (date, time, is_active, created_at) VALUES (?, ?, 1, ?)
          ON CONFLICT(date, time) DO UPDATE SET is_active = 1
        `).bind(date, time, timestamp));
      }
    }
  }
  if (statements.length) await db.batch(statements);
  return statements.length;
}

async function updateProfile(db, userId, data) {
  const name = requireText(data.name, "Informe um nome válido.");
  if (name.length < 2) throw new ApiError(400, "Informe um nome válido.");
  const existing = await db.prepare("SELECT id, username, phone, role FROM users WHERE id = ?").bind(userId).first();
  if (!existing) throw new ApiError(404, "Usuário não encontrado.");
  const phone = data.phone == null ? existing.phone : String(data.phone).trim();
  let username = existing.username;
  if (data.username != null && existing.username !== "admin") {
    username = String(data.username).trim().toLowerCase();
    if (username.length < 3) throw new ApiError(400, "Informe um e-mail/usuário válido.");
    const conflict = await db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").bind(username, userId).first();
    if (conflict) throw new ApiError(400, "Este e-mail/usuário já está em uso.");
  }
  await db.prepare("UPDATE users SET name = ?, phone = ?, username = ? WHERE id = ?")
    .bind(name, phone, username, userId).run();
  return { id: userId, username, name, phone, role: existing.role };
}

function whatsappNumber(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10) return "";
  return digits.length <= 11 ? `55${digits}` : digits;
}

function formatDate(date) {
  const [year, month, day] = String(date).split("-");
  return year && month && day ? `${day}/${month}/${year}` : String(date);
}

async function sendWhatsApp(env, phone, template, params) {
  const to = whatsappNumber(phone);
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !template || !to) return;
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template,
          language: { code: "pt_BR" },
          components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text: String(text) })) }],
        },
      }),
    });
    if (!response.ok) console.error("WhatsApp API error:", response.status, await response.text());
  } catch (error) {
    console.error("WhatsApp send failure:", error);
  }
}

// Falhas no envio nunca devem impedir o agendamento.
async function notifyAppointment(env, db, appointmentId, event) {
  const a = await db.prepare(`
    SELECT a.date, a.time, u.name AS client_name, u.phone AS client_phone, s.name AS service_name
    FROM appointments a JOIN users u ON u.id = a.client_id JOIN services s ON s.id = a.service_id
    WHERE a.id = ?
  `).bind(appointmentId).first();
  if (!a) return;
  const date = formatDate(a.date);
  if (event === "created") {
    await sendWhatsApp(env, a.client_phone, env.WHATSAPP_TEMPLATE_CLIENT_RECEIVED, [a.client_name, a.service_name, date, a.time]);
    const admin = await db.prepare("SELECT phone FROM users WHERE username = 'admin'").first();
    await sendWhatsApp(env, env.ADMIN_NOTIFY_PHONE || admin?.phone || env.ADMIN_PHONE,
      env.WHATSAPP_TEMPLATE_ADMIN_NEW, [a.client_name, a.service_name, date, a.time, a.client_phone || "-"]);
  } else if (event === "confirmado") {
    await sendWhatsApp(env, a.client_phone, env.WHATSAPP_TEMPLATE_CLIENT_CONFIRMED, [a.client_name, a.service_name, date, a.time]);
  }
}

async function handle(request, env, ctx) {
  const db = env.DB;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  await bootstrap(env);

  if (method === "POST" && path === "/api/auth/register") {
    const data = await bodyJson(request);
    const username = requireText(data.username, "Preencha todos os campos obrigatórios.").toLowerCase();
    const name = requireText(data.name, "Preencha todos os campos obrigatórios.");
    const phone = String(data.phone || "").trim();
    const password = requireText(data.password, "Preencha todos os campos obrigatórios.");
    if (password.length < 4) throw new ApiError(400, "A senha deve ter pelo menos 4 caracteres.");
    if (await db.prepare("SELECT id FROM users WHERE username = ?").bind(username).first()) {
      throw new ApiError(400, "Este nome de usuário ou e-mail já está cadastrado.");
    }
    const timestamp = now();
    const result = await db.prepare(`
      INSERT INTO users (username, name, phone, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, 'client', ?) RETURNING id
    `).bind(username, name, phone, await hashPassword(password), timestamp).first();
    const token = randomHex(24);
    await db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)")
      .bind(token, result.id, timestamp).run();
    return json({ token, user: { id: result.id, username, name, phone, role: "client" } });
  }

  if (method === "POST" && path === "/api/auth/login") {
    const data = await bodyJson(request);
    const username = String(data.username || "").trim().toLowerCase();
    const password = String(data.password || "").trim();
    const user = await db.prepare(`
      SELECT id, username, name, phone, password_hash, role FROM users WHERE username = ?
    `).bind(username).first();
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw new ApiError(401, "Usuário ou senha incorretos.");
    }
    const token = randomHex(24);
    await db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)")
      .bind(token, user.id, now()).run();
    return json({ token, user: { id: user.id, username: user.username, name: user.name, phone: user.phone, role: user.role } });
  }

  if (method === "GET" && path === "/api/auth/me") {
    return json({ user: await currentUser(request, db) });
  }

  if (method === "PUT" && path === "/api/auth/profile") {
    const user = await currentUser(request, db);
    return json({ message: "Dados atualizados com sucesso.", user: await updateProfile(db, user.id, await bodyJson(request)) });
  }

  if (method === "PUT" && /^\/api\/supervisor\/clients\/\d+$/.test(path)) {
    await supervisor(request, db);
    const id = parseId(path.split("/").pop());
    const client = await db.prepare("SELECT role FROM users WHERE id = ?").bind(id).first();
    if (!client || client.role !== "client") throw new ApiError(404, "Cliente não encontrada.");
    await updateProfile(db, id, await bodyJson(request));
    return json({ message: "Dados da cliente atualizados com sucesso." });
  }

  if (method === "POST" && path === "/api/auth/change-password") {
    const user = await currentUser(request, db);
    const data = await bodyJson(request);
    const newPassword = String(data.new_password || "").trim();
    if (newPassword.length < 4) throw new ApiError(400, "A nova senha deve ter pelo menos 4 caracteres.");
    const record = await db.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user.id).first();
    if (!record || !(await verifyPassword(String(data.current_password || "").trim(), record.password_hash))) {
      throw new ApiError(400, "Senha atual incorreta.");
    }
    const token = (request.headers.get("Authorization") || "").slice(7);
    await db.batch([
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(newPassword), user.id),
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").bind(user.id, token),
    ]);
    return json({ message: "Senha alterada com sucesso." });
  }

  if (method === "GET" && path === "/api/supervisor/clients") {
    await supervisor(request, db);
    return json(await rows(db.prepare("SELECT id, username, name, phone FROM users WHERE role = 'client' ORDER BY name COLLATE NOCASE")));
  }

  if (method === "POST" && /^\/api\/supervisor\/clients\/\d+\/reset-password$/.test(path)) {
    await supervisor(request, db);
    const id = parseId(path.split("/")[4]);
    const result = await db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND role = 'client'")
      .bind(await hashPassword("1234"), id).run();
    if (!result.meta.changes) throw new ApiError(404, "Cliente não encontrado.");
    await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
    return json({ message: "Senha redefinida para 1234. A cliente pode alterá-la depois em 'Minha Conta'." });
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const authorization = request.headers.get("Authorization") || "";
    if (authorization.startsWith("Bearer ")) {
      await db.prepare("DELETE FROM sessions WHERE token = ?").bind(authorization.slice(7)).run();
    }
    return json({ message: "Desconectado com sucesso." });
  }

  if (method === "GET" && path === "/api/contact") {
    const admin = await db.prepare("SELECT phone FROM users WHERE username = 'admin'").first();
    const instagram = await db.prepare("SELECT value FROM site_settings WHERE key = 'instagram_url'").first();
    return json({ phone: admin?.phone || "", instagram_url: instagram?.value || "" });
  }

  if (method === "PUT" && path === "/api/supervisor/settings") {
    await supervisor(request, db);
    const data = await bodyJson(request);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ApiError(400, "Informe os dados de configuração do site.");
    }
    const instagramUrl = validateInstagramUrl(data.instagram_url);
    if (instagramUrl) {
      await db.prepare(`
        INSERT INTO site_settings (key, value) VALUES ('instagram_url', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).bind(instagramUrl).run();
    } else {
      await db.prepare("DELETE FROM site_settings WHERE key = 'instagram_url'").run();
    }
    return json({ message: "Link do Instagram atualizado com sucesso.", instagram_url: instagramUrl });
  }

  if (method === "GET" && path === "/api/services") {
    return json(await rows(db.prepare("SELECT id, name, description, price, duration_minutes FROM services ORDER BY id")));
  }

  if (method === "POST" && path === "/api/supervisor/services") {
    await supervisor(request, db);
    const data = await bodyJson(request);
    validateService(data);
    await db.prepare("INSERT INTO services (name, description, price, duration_minutes) VALUES (?, ?, ?, ?)")
      .bind(data.name.trim(), String(data.description || "").trim(), Number(data.price), Number(data.duration_minutes)).run();
    return json({ message: "Serviço criado com sucesso." });
  }

  if (method === "PUT" && /^\/api\/supervisor\/services\/\d+$/.test(path)) {
    await supervisor(request, db);
    const id = parseId(path.split("/").pop());
    const data = await bodyJson(request);
    validateService(data);
    const result = await db.prepare(`
      UPDATE services SET name = ?, description = ?, price = ?, duration_minutes = ? WHERE id = ?
    `).bind(data.name.trim(), String(data.description || "").trim(), Number(data.price), Number(data.duration_minutes), id).run();
    if (!result.meta.changes) throw new ApiError(404, "Serviço não encontrado.");
    return json({ message: "Serviço atualizado com sucesso." });
  }

  if (method === "DELETE" && /^\/api\/supervisor\/services\/\d+$/.test(path)) {
    await supervisor(request, db);
    const id = parseId(path.split("/").pop());
    const count = await db.prepare("SELECT COUNT(*) AS total FROM appointments WHERE service_id = ?").bind(id).first();
    if (count.total) throw new ApiError(400, "Este serviço possui agendamentos e não pode ser excluído. Edite-o em vez disso.");
    await db.prepare("DELETE FROM services WHERE id = ?").bind(id).run();
    return json({ message: "Serviço excluído com sucesso." });
  }

  if (method === "GET" && path === "/api/schedules/available") {
    const date = url.searchParams.get("date");
    if (!date) throw new ApiError(400, "O parâmetro date é obrigatório.");
    return json(await rows(db.prepare(`
      SELECT s.id, s.date, s.time
      FROM schedules s
      WHERE s.date = ? AND s.is_active = 1
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.schedule_id = s.id AND a.status IN ('pendente', 'confirmado'))
      ORDER BY s.time ASC
    `).bind(date)));
  }

  if (method === "GET" && path === "/api/supervisor/schedules") {
    await supervisor(request, db);
    const date = url.searchParams.get("date");
    const query = `
      SELECT s.id, s.date, s.time, s.is_active,
             a.id AS appointment_id, a.status AS appointment_status,
             u.name AS client_name, u.phone AS client_phone, srv.name AS service_name
      FROM schedules s
      LEFT JOIN appointments a ON s.id = a.schedule_id AND a.status IN ('pendente', 'confirmado')
      LEFT JOIN users u ON a.client_id = u.id
      LEFT JOIN services srv ON a.service_id = srv.id
      ${date ? "WHERE s.date = ?" : ""}
      ORDER BY ${date ? "s.time ASC" : "s.date DESC, s.time ASC"} ${date ? "" : "LIMIT 200"}
    `;
    return json(await rows(date ? db.prepare(query).bind(date) : db.prepare(query)));
  }

  if (method === "POST" && path === "/api/supervisor/schedules") {
    await supervisor(request, db);
    const data = await bodyJson(request);
    if (!data.date || !Array.isArray(data.times) || !data.times.length) throw new ApiError(400, "Data e horários são obrigatórios.");
    const count = await upsertSchedules(db, [data.date], data.times);
    return json({ message: `${count} horário(s) autorizados com sucesso para clientes na data ${data.date}.` });
  }

  if (method === "POST" && path === "/api/supervisor/schedules/dates") {
    await supervisor(request, db);
    const data = await bodyJson(request);
    const times = Array.isArray(data.times) ? data.times.map((time) => String(time).trim()).filter(Boolean) : [];
    if (!Array.isArray(data.dates) || !data.dates.length || !times.length) throw new ApiError(400, "Datas e horários são obrigatórios.");
    if (!data.dates.every(validateDate)) throw new ApiError(400, "Formato de data inválido. Use AAAA-MM-DD.");
    const dates = [...new Set(data.dates)].sort();
    await upsertSchedules(db, dates, times);
    return json({ message: `${dates.length * times.length} horário(s) autorizados em ${dates.length} dia(s).` });
  }

  if (method === "POST" && path === "/api/supervisor/schedules/bulk") {
    await supervisor(request, db);
    const data = await bodyJson(request);
    if (!validateDate(data.start_date) || !validateDate(data.end_date)) throw new ApiError(400, "Formato de data inválido. Use AAAA-MM-DD.");
    const start = Date.parse(`${data.start_date}T00:00:00Z`);
    const end = Date.parse(`${data.end_date}T00:00:00Z`);
    if (start > end) throw new ApiError(400, "Data inicial não pode ser maior que data final.");
    const totalDays = Math.floor((end - start) / 86_400_000) + 1;
    if (totalDays > 366) throw new ApiError(400, "O período máximo para geração em lote é de 366 dias.");
    if (!Array.isArray(data.times) || !data.times.length) throw new ApiError(400, "Datas e horários são obrigatórios.");
    const dates = Array.from({ length: totalDays }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
    const count = await upsertSchedules(db, dates, data.times);
    return json({ message: `${count} horários autorizados no período com sucesso.` });
  }

  if (method === "PATCH" && /^\/api\/supervisor\/schedules\/\d+\/toggle$/.test(path)) {
    await supervisor(request, db);
    const id = parseId(path.split("/")[4]);
    const active = await db.prepare("SELECT is_active FROM schedules WHERE id = ?").bind(id).first();
    if (!active) throw new ApiError(404, "Horário não encontrado.");
    const occupied = await db.prepare("SELECT id FROM appointments WHERE schedule_id = ? AND status IN ('pendente', 'confirmado')").bind(id).first();
    if (occupied) throw new ApiError(400, "Não é possível alterar este horário pois ele já possui um agendamento ativo de cliente.");
    const newStatus = active.is_active ? 0 : 1;
    await db.prepare("UPDATE schedules SET is_active = ? WHERE id = ?").bind(newStatus, id).run();
    const label = newStatus ? "autorizado e disponível para clientes" : "marcado como indisponível/bloqueado";
    return json({ message: `Horário ${label}.`, is_active: newStatus });
  }

  if (method === "POST" && /^\/api\/supervisor\/schedules\/day\/(block-all|authorize-all)$/.test(path)) {
    await supervisor(request, db);
    const data = await bodyJson(request);
    if (!data.date) throw new ApiError(400, "Data obrigatória.");
    if (path.endsWith("block-all")) {
      await db.prepare(`
        UPDATE schedules SET is_active = 0
        WHERE date = ? AND NOT EXISTS (
          SELECT 1 FROM appointments a WHERE a.schedule_id = schedules.id AND a.status IN ('pendente', 'confirmado')
        )
      `).bind(data.date).run();
      return json({ message: `Todos os horários de ${data.date} foram bloqueados e estão indisponíveis para clientes.` });
    }
    await db.prepare("UPDATE schedules SET is_active = 1 WHERE date = ?").bind(data.date).run();
    return json({ message: `Todos os horários de ${data.date} foram autorizados com sucesso para clientes.` });
  }

  if (method === "DELETE" && /^\/api\/supervisor\/schedules\/\d+$/.test(path)) {
    await supervisor(request, db);
    const id = parseId(path.split("/").pop());
    const occupied = await db.prepare("SELECT id FROM appointments WHERE schedule_id = ? AND status IN ('pendente', 'confirmado')").bind(id).first();
    if (occupied) throw new ApiError(400, "Não é possível excluir um horário que possui agendamento ativo.");
    await db.prepare("DELETE FROM schedules WHERE id = ?").bind(id).run();
    return json({ message: "Horário removido com sucesso." });
  }

  if (method === "POST" && path === "/api/appointments") {
    const user = await currentUser(request, db);
    const data = await bodyJson(request);
    const observation = String(data.observation || "").trim();
    if (observation.length > 200) throw new ApiError(400, "A observação deve ter no máximo 200 caracteres.");
    const created = await db.prepare(`
      INSERT INTO appointments (client_id, service_id, schedule_id, date, time, observation, status, created_at, updated_at)
      SELECT ?, ?, s.id, s.date, s.time, ?, 'pendente', ?, ?
      FROM schedules s
      WHERE s.id = ? AND s.is_active = 1 AND EXISTS (SELECT 1 FROM services WHERE id = ?)
      RETURNING id
    `).bind(user.id, data.service_id, observation, now(), now(), data.schedule_id, data.service_id).first();
    if (!created) {
      const schedule = await db.prepare("SELECT is_active FROM schedules WHERE id = ?").bind(data.schedule_id).first();
      if (!schedule || !schedule.is_active) throw new ApiError(400, "Este horário não está autorizado pela supervisora ou foi bloqueado.");
      if (!(await db.prepare("SELECT id FROM services WHERE id = ?").bind(data.service_id).first())) {
        throw new ApiError(400, "Serviço não encontrado.");
      }
      throw new ApiError(400, "Este horário já foi reservado por outra cliente. Por favor, escolha outro horário vago.");
    }
    ctx.waitUntil(notifyAppointment(env, db, created.id, "created"));
    return json({ message: "Agendamento realizado com sucesso! Aguarde a confirmação da supervisora.", appointment_id: created.id });
  }

  if (method === "GET" && path === "/api/appointments/my") {
    const user = await currentUser(request, db);
    return json(await rows(db.prepare(`
      SELECT a.id, a.date, a.time, a.observation, a.status, a.created_at,
             s.name AS service_name, s.price AS service_price, s.duration_minutes
      FROM appointments a JOIN services s ON s.id = a.service_id
      WHERE a.client_id = ? ORDER BY a.date DESC, a.time DESC
    `).bind(user.id)));
  }

  if (method === "POST" && /^\/api\/appointments\/\d+\/cancel$/.test(path)) {
    const user = await currentUser(request, db);
    const id = parseId(path.split("/")[3]);
    const appointment = await db.prepare("SELECT id, client_id, status FROM appointments WHERE id = ?").bind(id).first();
    if (!appointment) throw new ApiError(404, "Agendamento não encontrado.");
    if (appointment.client_id !== user.id && user.role !== "supervisor") {
      throw new ApiError(403, "Você não tem permissão para cancelar este agendamento.");
    }
    if (["cancelado", "concluido"].includes(appointment.status)) {
      throw new ApiError(400, "Este agendamento já foi finalizado ou cancelado.");
    }
    await db.prepare("UPDATE appointments SET status = 'cancelado', updated_at = ? WHERE id = ?").bind(now(), id).run();
    return json({ message: "Agendamento cancelado com sucesso." });
  }

  if (method === "GET" && path === "/api/supervisor/appointments") {
    await supervisor(request, db);
    const conditions = [];
    const values = [];
    const status = url.searchParams.get("status");
    const date = url.searchParams.get("date");
    if (status && status !== "todos") { conditions.push("a.status = ?"); values.push(status); }
    if (date) { conditions.push("a.date = ?"); values.push(date); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const query = `
      SELECT a.id, a.date, a.time, a.observation, a.status, a.created_at, a.updated_at,
             u.id AS client_id, u.name AS client_name, u.phone AS client_phone, u.username AS client_username,
             s.id AS service_id, s.name AS service_name, s.price AS service_price, s.duration_minutes
      FROM appointments a JOIN users u ON u.id = a.client_id JOIN services s ON s.id = a.service_id
      ${where} ORDER BY a.date DESC, a.time DESC
    `;
    const statement = db.prepare(query);
    return json(await rows(values.length ? statement.bind(...values) : statement));
  }

  if (method === "PATCH" && /^\/api\/supervisor\/appointments\/\d+\/status$/.test(path)) {
    await supervisor(request, db);
    const id = parseId(path.split("/")[4]);
    const data = await bodyJson(request);
    const labels = {
      confirmado: "confirmado com sucesso!",
      cancelado: "cancelado.",
      concluido: "marcado como concluído!",
      pendente: "redefinido para pendente.",
    };
    if (!Object.hasOwn(labels, data.status)) {
      throw new ApiError(400, "Status inválido. Escolha entre: pendente, confirmado, concluido, cancelado");
    }
    const result = await db.prepare("UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?")
      .bind(data.status, now(), id).run();
    if (!result.meta.changes) throw new ApiError(404, "Agendamento não encontrado.");
    if (data.status === "confirmado") ctx.waitUntil(notifyAppointment(env, db, id, "confirmado"));
    return json({ message: `Agendamento ${labels[data.status]}`, status: data.status });
  }

  throw new ApiError(404, "Endpoint não encontrado.");
}

export async function onRequest(context) {
  try {
    return await handle(context.request, context.env, context);
  } catch (error) {
    if (error instanceof ApiError) return json({ detail: error.message }, error.status);
    if (String(error?.message || "").includes("UNIQUE constraint failed: appointments.schedule_id")) {
      return json({ detail: "Este horário já foi reservado por outra cliente. Por favor, escolha outro horário vago." }, 400);
    }
    if (String(error?.message || "").includes("UNIQUE constraint failed: users.username")) {
      return json({ detail: "Este nome de usuário ou e-mail já está cadastrado." }, 400);
    }
    console.error("Cloudflare Pages API error:", error);
    return json({ detail: "Erro interno ao processar a solicitação." }, 500);
  }
}
