'use strict';

require('./services/Server');

const WireGuard = require('./services/WireGuard');

WireGuard.getConfig()
  .then(() => {
    // Запускаем периодический фоновый пересчёт трафика (каждые 5 минут),
    // чтобы данные сохранялись на диск регулярно, а не только когда кто-то
    // открывает веб-интерфейс или при штатном завершении процесса.
    // Это уменьшает риск потери накопленного трафика при "жёсткой"
    // перезагрузке/аварийном завершении сервера.
    WireGuard.startTrafficMonitor();
  })
  .catch((err) => {
  // eslint-disable-next-line no-console
    console.error(err);

    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });

// Handle terminate signal
process.on('SIGTERM', async () => {
  // eslint-disable-next-line no-console
  console.log('SIGTERM signal received.');
  WireGuard.stopTrafficMonitor();
  await WireGuard.Shutdown();
  // eslint-disable-next-line no-process-exit
  process.exit(0);
});

// Handle interrupt signal
process.on('SIGINT', () => {
  // eslint-disable-next-line no-console
  console.log('SIGINT signal received.');
});
