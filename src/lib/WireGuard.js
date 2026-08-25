'use strict';

const fs = require('node:fs/promises');
const path = require('path');
const debug = require('debug')('WireGuard');
const crypto = require('node:crypto');
const QRCode = require('qrcode');

const Util = require('./Util');
const ServerError = require('./ServerError');

const {
  WG_PATH,
  WG_HOST,
  WG_PORT,
  WG_CONFIG_PORT,
  WG_MTU,
  WG_DEFAULT_DNS,
  WG_DEFAULT_ADDRESS,
  WG_PERSISTENT_KEEPALIVE,
  WG_ALLOWED_IPS,
  WG_PRE_UP,
  WG_POST_UP,
  WG_PRE_DOWN,
  WG_POST_DOWN,
  PROTOCOL,
} = require('../config');

// Утилита для генерации случайного числа
function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = class WireGuard {
  // Путь к файлу с данными трафика
  static TRAFFIC_PATH = path.join(WG_PATH, 'traffic.json');

  // "Очередь" (mutex) для сериализации доступа к traffic.json.
  // Node.js однопоточный, но async-код может переключаться между операциями
  // на любом `await`, поэтому без блокировки два параллельных запроса могли
  // одновременно прочитать traffic.json, независимо посчитать новые значения
  // и записать их — при этом обновление, записанное первым, терялось бы
  // (классическая гонка read-modify-write). Все операции чтения+записи
  // traffic.json теперь по очереди проходят через __withTrafficLock().
  __trafficLock = Promise.resolve();

  // Ссылка на таймер периодического фонового обновления трафика (см. startTrafficMonitor)
  __trafficMonitorTimer = null;

  // Выполняет переданную асинхронную функцию так, чтобы в один момент времени
  // выполнялась только одна такая операция с traffic.json — остальные ждут
  // своей очереди. Даже если task() выбросит ошибку, блокировка корректно
  // снимается (следующая операция из очереди не "зависнет").
  async __withTrafficLock(task) {
    const previous = this.__trafficLock;
    let release;
    this.__trafficLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  // Запускает периодическое фоновое обновление трафика (по умолчанию раз в 5 минут).
  //
  // Раньше updateMonthlyTraffic() вызывалась ТОЛЬКО когда кто-то открывал
  // веб-интерфейс (внутри getClients()) или при штатном завершении процесса
  // (Shutdown(), например по SIGTERM). Если сервер перезагружался "жёстко"
  // (сброс питания, OOM-kill, `docker kill` и т.п. — без вызова Shutdown()),
  // а между визитами в UI прошло много времени, то весь трафик, накопленный
  // WireGuard-интерфейсом с момента последнего пересчёта, терялся безвозвратно:
  // счётчик интерфейса обнулялся при перезапуске раньше, чем программа успевала
  // снять с него "снимок".
  //
  // Регулярный фоновый вызов сокращает окно потенциальной потери данных
  // с "сколько угодно долго между визитами в UI" до размера интервала
  // (по умолчанию 5 минут).
  startTrafficMonitor(intervalMs = 5 * 60 * 1000) {
    if (this.__trafficMonitorTimer) {
      return; // уже запущен, повторный запуск не нужен
    }
    this.__trafficMonitorTimer = setInterval(() => {
      this.updateMonthlyTraffic().catch((err) => {
        debug(`Periodic traffic update failed: ${err.message}`);
      });
    }, intervalMs);
    // unref(), чтобы этот таймер не мешал процессу штатно завершиться
    if (typeof this.__trafficMonitorTimer.unref === 'function') {
      this.__trafficMonitorTimer.unref();
    }
    debug(`Traffic monitor started (interval: ${intervalMs}ms)`);
  }

  // Останавливает фоновое обновление трафика (используется при штатном завершении)
  stopTrafficMonitor() {
    if (this.__trafficMonitorTimer) {
      clearInterval(this.__trafficMonitorTimer);
      this.__trafficMonitorTimer = null;
    }
  }

  async __buildConfig() {
    this.__configPromise = Promise.resolve().then(async () => {
      if (!WG_HOST) {
        throw new Error('WG_HOST Environment Variable Not Set!');
      }

      debug('Loading configuration...');
      let config;
      try {
        config = await fs.readFile(path.join(WG_PATH, 'wg0.json'), 'utf8');
        config = JSON.parse(config);
        debug('Configuration loaded.');
      } catch (err) {
        const privateKey = await Util.exec('wg genkey');
        const publicKey = await Util.exec(`echo ${privateKey} | wg pubkey`, {
          log: 'echo ***hidden*** | wg pubkey',
        });
        const address = WG_DEFAULT_ADDRESS.replace('x', '1');

        config = {
          server: {
            privateKey,
            publicKey,
            address,
          },
          clients: {},
        };
        debug('Configuration generated.');
      }

      return config;
    });

    return this.__configPromise;
  }

  async getConfig() {
    if (!this.__configPromise) {
      const config = await this.__buildConfig();

      await this.__saveConfig(config);
      await Util.exec('wg-quick down wg0').catch(() => {});
      await Util.exec('wg-quick up wg0').catch((err) => {
        if (err && err.message && err.message.includes('Cannot find device "wg0"')) {
          throw new Error('WireGuard exited with the error: Cannot find device "wg0"\nThis usually means that your host\'s kernel does not support WireGuard!');
        }

        throw err;
      });
      await this.__syncConfig();
    }

    return this.__configPromise;
  }

  async saveConfig() {
    const config = await this.getConfig();
    await this.__saveConfig(config);
    await this.__syncConfig();
  }

  async __saveConfig(config) {
    let result = `
# Note: Do not edit this file directly.
# Your changes will be overwritten!

# Server
[Interface]
PrivateKey = ${config.server.privateKey}
Address = ${config.server.address}/24
ListenPort = ${WG_PORT}
PreUp = ${WG_PRE_UP}
PostUp = ${WG_POST_UP}
PreDown = ${WG_PRE_DOWN}
PostDown = ${WG_POST_DOWN}
`;

    for (const [clientId, client] of Object.entries(config.clients)) {
      if (!client.enabled) continue;

      result += `

# Client: ${client.name} (${clientId})
[Peer]
PublicKey = ${client.publicKey}
${client.preSharedKey ? `PresharedKey = ${client.preSharedKey}\n` : ''}AllowedIPs = ${client.address}/32`;
    }

    debug('Config saving...');
    await fs.writeFile(path.join(WG_PATH, 'wg0.json'), JSON.stringify(config, false, 2), {
      mode: 0o660,
    });
    await fs.writeFile(path.join(WG_PATH, 'wg0.conf'), result, {
      mode: 0o600,
    });
    debug('Config saved.');
  }

  async __syncConfig() {
    debug('Config syncing...');
    await Util.exec('wg syncconf wg0 <(wg-quick strip wg0)');
    debug('Config synced.');
  }

  async getClients() {
    const config = await this.getConfig();
    // ВАЖНО: сначала пересчитываем и сохраняем трафик (updateMonthlyTraffic сама
    // читает и сохраняет актуальный traffic.json), и только ПОСЛЕ этого читаем
    // его для формирования ответа. Раньше порядок был обратный: trafficData
    // читался до пересчёта, из-за чего пользователь в UI видел данные,
    // актуальные на момент ПРЕДЫДУЩЕГО запроса, а не только что посчитанные.
    await this.updateMonthlyTraffic(); // Обновляем трафик перед получением данных
    const trafficData = await this.getTrafficData();
    let configUpdated = false; // Флаг для отслеживания необходимости сохранения конфигурации
	const currentDate = new Date();
    const clients = Object.entries(config.clients).map(([clientId, client]) => {
      const monthlyTraffic = trafficData.clients[clientId] || {};
	  
	  // Проверяем, истек ли срок действия клиента
       if (client.enabled && client.expiresAt && new Date(client.expiresAt) <= currentDate) {
           debug(`Disabling client ${clientId} (${client.name}) due to expiration at ${client.expiresAt}`);
		   client.enabled = false; // Отключаем клиента
           client.updatedAt = new Date().toISOString();
           configUpdated = true; // Устанавливаем флаг для сохранения конфигурации
        }
	  
      return {
        id: clientId,
        name: client.name,
        enabled: client.enabled && (!client.expiresAt || new Date(client.expiresAt) > new Date()),
        address: client.address,
        publicKey: client.publicKey,
        Jc: client.Jc,
        Jmin: client.Jmin,
        Jmax: client.Jmax,
        type: client.type || 'wireguard',
        expiresAt: client.expiresAt && !isNaN(new Date(client.expiresAt)) ? new Date(client.expiresAt).toISOString() : null,
        createdAt: new Date(client.createdAt),
        updatedAt: new Date(client.updatedAt),
        allowedIPs: client.allowedIPs,
        downloadableConfig: 'privateKey' in client,
        persistentKeepalive: null,
        latestHandshakeAt: client.latestHandshakeAt ? new Date(client.latestHandshakeAt) : null, // Используем сохраненное значение
        transferRx: null,
        transferTx: null,
        monthlyTraffic,
      };
    });

    // Loop WireGuard status
    const dump = await Util.exec('wg show wg0 dump', {
      log: false,
    });
    dump
      .trim()
      .split('\n')
      .slice(1)
      .forEach((line) => {
        const [
          publicKey,
          preSharedKey, // eslint-disable-line no-unused-vars
          endpoint, // eslint-disable-line no-unused-vars
          allowedIps, // eslint-disable-line no-unused-vars
          latestHandshakeAt,
          transferRx,
          transferTx,
          persistentKeepalive,
        ] = line.split('\t');

        const client = clients.find((client) => client.publicKey === publicKey);
        if (!client) return;

        // Проверяем, изменилось ли значение latestHandshakeAt
        const newHandshakeAt = latestHandshakeAt === '0' ? null : new Date(Number(`${latestHandshakeAt}000`));
        if (newHandshakeAt && (!client.latestHandshakeAt || newHandshakeAt > client.latestHandshakeAt)) {
          // Обновляем latestHandshakeAt в конфигурации
          config.clients[client.id].latestHandshakeAt = newHandshakeAt ? newHandshakeAt.toISOString() : null;
          config.clients[client.id].updatedAt = new Date().toISOString();
          configUpdated = true; // Устанавливаем флаг, что конфигурация изменилась
        }

        client.latestHandshakeAt = newHandshakeAt || client.latestHandshakeAt;
        client.transferRx = Number(transferRx);
        client.transferTx = Number(transferTx);
        client.persistentKeepalive = persistentKeepalive;
      });
      if (configUpdated) {
    //debug('Saving updated configuration with new latestHandshakeAt values...');
    await this.saveConfig();
    debug('Configuration saved.');
  }

    return clients;
  }

  async getClient({ clientId }) {
    const config = await this.getConfig();
    const client = config.clients[clientId];
    if (!client) {
      throw new ServerError(`Client Not Found: ${clientId}`, 404);
    }

    return client;
  }

  async getClientConfiguration({ clientId }) {
    const config = await this.getConfig();
    const client = await this.getClient({ clientId });

    if (client.type === 'wireguard') {
      return `
[Interface]
PrivateKey = ${client.privateKey ? `${client.privateKey}` : 'REPLACE_ME'}
Address = ${client.address}/32
${WG_DEFAULT_DNS ? `DNS = ${WG_DEFAULT_DNS}\n` : ''}${WG_MTU ? `MTU = ${WG_MTU}\n` : ''}

[Peer]
PublicKey = ${config.server.publicKey}
${client.preSharedKey ? `PresharedKey = ${client.preSharedKey}\n` : ''}AllowedIPs = ${WG_ALLOWED_IPS}
PersistentKeepalive = ${WG_PERSISTENT_KEEPALIVE}
Endpoint = ${WG_HOST}:${WG_CONFIG_PORT}`;
    } else if (client.type === 'amneziawg') {
      const Jmax = (client.Jmax >= 1 && client.Jmax <= 1280) ? client.Jmax : getRandomInt(1, 1280);
      const Jmin = (client.Jmin >= 1 && client.Jmin <= Jmax) ? client.Jmin : getRandomInt(1, Jmax);
      const Jc = (client.Jc >= 1 && client.Jc <= 128) ? client.Jc : getRandomInt(1, 128);

      return `
[Interface]
PrivateKey = ${client.privateKey ? `${client.privateKey}` : 'REPLACE_ME'}
Address = ${client.address}/32
${WG_DEFAULT_DNS ? `DNS = ${WG_DEFAULT_DNS}\n` : ''}${WG_MTU ? `MTU = ${WG_MTU}\n` : ''}

Jc = ${Jc}
Jmin = ${Jmin}
Jmax = ${Jmax}
S1 = 0
S2 = 0
H1 = 1
H2 = 2
H3 = 3
H4 = 4

[Peer]
PublicKey = ${config.server.publicKey}
${client.preSharedKey ? `PresharedKey = ${client.preSharedKey}\n` : ''}AllowedIPs = ${WG_ALLOWED_IPS}
PersistentKeepalive = ${WG_PERSISTENT_KEEPALIVE}
Endpoint = ${WG_HOST}:${WG_CONFIG_PORT}`;
    } else {
      throw new ServerError(`Invalid client type: ${client.type}`, 400);
    }
  }

  async getClientQRCodeSVG({ clientId }) {
    const config = await this.getClientConfiguration({ clientId });
    return QRCode.toString(config, {
      type: 'svg',
      width: 512,
    });
  }

  async createClient({ name, type, Jc, Jmin, Jmax, expiresAt }) {
    if (!name) {
      throw new Error('Missing: Name');
    }
    if (!['wireguard', 'amneziawg'].includes(type)) {
      throw new Error('Missing or invalid: Type');
    }
    if (expiresAt && isNaN(new Date(expiresAt))) {
      expiresAt = null;
    }
    const config = await this.getConfig();

    const privateKey = await Util.exec('wg genkey');
    const publicKey = await Util.exec(`echo ${privateKey} | wg pubkey`, {
      log: 'echo ***hidden*** | wg pubkey',
    });
    const preSharedKey = await Util.exec('wg genpsk');

    // Calculate next IP
    let address;
    for (let i = 2; i < 255; i++) {
      const client = Object.values(config.clients).find((client) => {
        return client.address === WG_DEFAULT_ADDRESS.replace('x', i);
      });

      if (!client) {
        address = WG_DEFAULT_ADDRESS.replace('x', i);
        break;
      }
    }

    if (!address) {
      throw new Error('Maximum number of clients reached.');
    }

    // Create Client
    const id = crypto.randomUUID();
    const expiresAtISO = expiresAt ? new Date(expiresAt).toISOString() : null;
    const client = {
      id,
      name,
      address,
      privateKey,
      publicKey,
      preSharedKey,
      type,
      Jc: type === 'amneziawg' ? (Jc || getRandomInt(1, 128)) : null,
      Jmin: type === 'amneziawg' ? (Jmin || getRandomInt(1, Jmax || 1280)) : null,
      Jmax: type === 'amneziawg' ? (Jmax || getRandomInt(1, 1280)) : null,
      expiresAt: expiresAtISO,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      enabled: true,
      latestHandshakeAt: null,
    };

    config.clients[id] = client;

    await this.saveConfig();

    return client;
  }

  async deleteClient({ clientId }) {
    const config = await this.getConfig();

    if (config.clients[clientId]) {
      delete config.clients[clientId];
      // Чтение + изменение + запись traffic.json — под той же блокировкой,
      // что и updateMonthlyTraffic(), чтобы не столкнуться с параллельным
      // фоновым/UI-пересчётом трафика, который мог бы читать/писать файл
      // в этот же момент времени.
      await this.__withTrafficLock(async () => {
        const trafficData = await this.getTrafficData();
        delete trafficData.clients[clientId];
        await this.saveTrafficData(trafficData);
      });
      await this.saveConfig();
    }
  }

  async enableClient({ clientId }) {
    const client = await this.getClient({ clientId });

    client.enabled = true;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async disableClient({ clientId }) {
    const client = await this.getClient({ clientId });

    client.enabled = false;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientName({ clientId, name }) {
    const client = await this.getClient({ clientId });

    client.name = name;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientAddress({ clientId, address }) {
    const client = await this.getClient({ clientId });

    if (!Util.isValidIPv4(address)) {
      throw new ServerError(`Invalid Address: ${address}`, 400);
    }

    client.address = address;
    client.updatedAt = new Date();

    await this.saveConfig();
  }

  async updateClientAmneziaParams({ clientId, Jc, Jmin, Jmax }) {
    const client = await this.getClient({ clientId });

    if (client.type !== 'amneziawg') {
      throw new ServerError('Client is not of type AmneziaWG', 400);
    }

    if (Jc < 1 || Jc > 128 || Jmin < 1 || Jmin > Jmax || Jmax < 1 || Jmax > 1280) {
      throw new ServerError('Invalid AmneziaWG parameters', 400);
    }

    client.Jc = Jc;
    client.Jmin = Jmin;
    client.Jmax = Jmax;
    client.updatedAt = new Date().toISOString();
    await this.saveConfig();
  }

  async updateClientExpiration({ clientId, expiresAt }) {
    const client = await this.getClient({ clientId });
    const expiresAtISO = expiresAt && !isNaN(new Date(expiresAt)) ? new Date(expiresAt).toISOString() : null;
    client.expiresAt = expiresAtISO;
    client.updatedAt = new Date().toISOString();

    await this.saveConfig();
  }

  async updateClientType({ clientId, type, Jc, Jmin, Jmax }) {
    const client = await this.getClient({ clientId });

    if (!['wireguard', 'amneziawg'].includes(type)) {
      throw new ServerError('Invalid client type', 400);
    }

    if (type === 'amneziawg') {
      if (Jc < 1 || Jc > 128 || Jmin < 1 || Jmin > Jmax || Jmax < 1 || Jmax > 1280) {
        throw new ServerError('Invalid AmneziaWG parameters', 400);
      }
      client.Jc = Jc || getRandomInt(1, 128);
      client.Jmin = Jmin || getRandomInt(1, Jmax || 1280);
      client.Jmax = Jmax || getRandomInt(1, 1280);
    } else {
      client.Jc = null;
      client.Jmin = null;
      client.Jmax = null;
    }

    client.type = type;
    client.updatedAt = new Date().toISOString();

    await this.saveConfig();
  }

  async __reloadConfig() {
    await this.__buildConfig();
    await this.__syncConfig();
  }

  async restoreConfiguration(config) {
    debug('Starting configuration restore process.');
    const _config = JSON.parse(config);
    await this.__saveConfig(_config);
    // Тоже через блокировку — полная перезапись traffic.json не должна
    // пересекаться по времени с фоновым/UI пересчётом трафика.
    await this.__withTrafficLock(() => this.saveTrafficData({ clients: {} }));
    await this.__reloadConfig();
    debug('Configuration restore process completed.');
  }

  async backupConfiguration() {
    debug('Starting configuration backup.');
    const config = await this.getConfig();
    const backup = JSON.stringify(config, null, 2);
    debug('Configuration backup completed.');
    return backup;
  }

  // Функция для чтения данных трафика
  async getTrafficData() {
    try {
      const data = await fs.readFile(WireGuard.TRAFFIC_PATH, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      // Если файл не существует, создаем пустую структуру
      return { clients: {} };
    }
  }

  // Функция для сохранения данных трафика
  async saveTrafficData(trafficData) {
    //debug('Saving traffic data...');
    await fs.writeFile(WireGuard.TRAFFIC_PATH, JSON.stringify(trafficData, null, 2), { mode: 0o660 });
    //debug('Traffic data saved.');
  }

  // Функция для обновления месячного трафика.
  // Вся операция (чтение traffic.json -> расчёт -> запись traffic.json)
  // выполняется под блокировкой __withTrafficLock, чтобы два параллельных
  // вызова (например, два одновременных запроса к UI) не читали и не писали
  // файл одновременно и не затирали обновления друг друга.
  async updateMonthlyTraffic() {
    return this.__withTrafficLock(() => this.__updateMonthlyTraffic());
  }

  async __updateMonthlyTraffic() {
    //debug('Starting updateMonthlyTraffic...');
    const config = await this.getConfig();
    //debug(`Loaded config with ${Object.keys(config.clients).length} clients`);
    const trafficData = await this.getTrafficData();
    //debug(`Loaded traffic data: ${JSON.stringify(trafficData, null, 2)}`);
    const currentDate = new Date();
    const currentMonth = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
    //debug(`Current month: ${currentMonth}`);

    // Получаем текущий трафик из WireGuard
    //debug('Executing wg show wg0 dump...');
    const dump = await Util.exec('wg show wg0 dump', { log: false });
    const clientsTraffic = {};
    dump.trim().split('\n').slice(1).forEach((line) => {
      const [publicKey, , , , , transferRx, transferTx] = line.split('\t');
      clientsTraffic[publicKey] = {
        transferRx: Number(transferRx),
        transferTx: Number(transferTx),
      };
      //debug(`Client publicKey: ${publicKey}, transferRx: ${transferRx}, transferTx: ${transferTx}`);
    });
    //debug(`Parsed ${Object.keys(clientsTraffic).length} clients from wg dump`);

    // Обновляем данные трафика для каждого клиента
    let updated = false;
    for (const [clientId, client] of Object.entries(config.clients)) {
      //debug(`Processing client: ${clientId} (${client.name})`);
      const clientTraffic = clientsTraffic[client.publicKey] || { transferRx: 0, transferTx: 0 };
      if (!trafficData.clients[clientId]) {
        trafficData.clients[clientId] = {};
        //debug(`Created new traffic entry for client: ${clientId}`);
      }
      //debug(`Client traffic for ${clientId}: transferRx=${clientTraffic.transferRx}, transferTx=${clientTraffic.transferTx}`);
      if (!trafficData.clients[clientId][currentMonth]) {
        // ВАЖНО: счётчики transferRx/transferTx в `wg show ... dump` являются
        // накопительными для сетевого интерфейса и обнуляются ТОЛЬКО при
        // перезапуске интерфейса (например, при перезагрузке сервера), а не при
        // смене месяца. Раньше здесь lastTransferRx/lastTransferTx всегда
        // выставлялись в 0 при создании записи нового месяца, из-за чего в первый
        // же вызов после смены месяца в дельту (deltaRx/deltaTx) засчитывался ВЕСЬ
        // текущий накопленный счётчик интерфейса (то есть весь трафик со времени
        // последней перезагрузки, а не трафик, реально прошедший в новом месяце).
        // Это и приводило к некорректному, завышенному месячному трафику.
        //
        // Исправление: при старте нового месяца в качестве базовой точки
        // (lastTransferRx/lastTransferTx) берём ТЕКУЩЕЕ значение счётчика
        // интерфейса на этот момент, а не 0. Тогда в первом же расчёте дельты
        // ниже получится 0 (мы просто фиксируем точку отсчёта), а весь трафик,
        // накопленный до начала месяца, корректно останется отнесён к
        // предыдущему месяцу (он уже был учтён туда ранее). Дальнейший рост
        // счётчика будет попадать в totalTransferRx/Tx уже правильно, вне
        // зависимости от того, перезагружался сервер или нет.
        trafficData.clients[clientId][currentMonth] = {
          totalTransferRx: 0, // Общее накопленное значение входящего трафика за месяц
          totalTransferTx: 0, // Общее накопленное значение исходящего трафика за месяц
          lastTransferRx: clientTraffic.transferRx, // Базовое (стартовое) значение счётчика wg на начало месяца
          lastTransferTx: clientTraffic.transferTx, // Базовое (стартовое) значение счётчика wg на начало месяца
          lastUpdated: new Date().toISOString(),
        };
        //debug(`Initialized traffic for ${clientId} in ${currentMonth}`);
      }
	  
	   // Вычисляем приращение трафика с последнего обновления
       const deltaRx = clientTraffic.transferRx < trafficData.clients[clientId][currentMonth].lastTransferRx
         ? clientTraffic.transferRx
         : Math.max(clientTraffic.transferRx - trafficData.clients[clientId][currentMonth].lastTransferRx, 0);
       const deltaTx = clientTraffic.transferTx < trafficData.clients[clientId][currentMonth].lastTransferTx
         ? clientTraffic.transferTx
         : Math.max(clientTraffic.transferTx - trafficData.clients[clientId][currentMonth].lastTransferTx, 0);

       // Обновляем общее накопленное значение
       if (deltaRx > 0 || deltaTx > 0) {
         trafficData.clients[clientId][currentMonth].totalTransferRx += deltaRx;
         trafficData.clients[clientId][currentMonth].totalTransferTx += deltaTx;
         trafficData.clients[clientId][currentMonth].lastTransferRx = clientTraffic.transferRx;
         trafficData.clients[clientId][currentMonth].lastTransferTx = clientTraffic.transferTx;
         trafficData.clients[clientId][currentMonth].lastUpdated = new Date().toISOString();
         updated = true;
         //debug(`Updated traffic for ${clientId}: deltaRx=${deltaRx}, deltaTx=${deltaTx}, totalRx=${trafficData.clients[clientId][currentMonth].totalTransferRx}, totalTx=${trafficData.clients[clientId][currentMonth].totalTransferTx}`);
        }

      // Удаляем данные старше года
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      for (const month of Object.keys(trafficData.clients[clientId])) {
        const monthDate = new Date(month + '-01');
        if (monthDate < oneYearAgo) {
          //debug(`Deleting old traffic data for ${clientId} in ${month}`);
          delete trafficData.clients[clientId][month];
          updated = true;
        }
      }
    }

    // Удаляем записи о клиентах, которых больше нет
    for (const clientId of Object.keys(trafficData.clients)) {
      if (!config.clients[clientId]) {
        //debug(`Deleting traffic data for non-existent client: ${clientId}`);
        delete trafficData.clients[clientId];
        updated = true;
      }
    }
    if (updated) {
      //debug('Saving updated traffic data...');
      await this.saveTrafficData(trafficData);
    }
    //debug('updateMonthlyTraffic completed');   
  }

  // Shutdown wireguard
  async Shutdown() {
    debug('Starting WireGuard shutdown...');
    await this.updateMonthlyTraffic();
    debug('Traffic data saved before shutdown');
    await Util.exec('wg-quick down wg0').catch(() => {
      debug('No active wg0 interface to shut down');
    });
    debug('WireGuard shutdown completed');
  }
};
