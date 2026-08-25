# WireGuard and AmneziaWG Easy

Вы нашли самый простой способ установки и управления WireGuard and AmneziaWG (обфусцированный Wireguard) на любом хосте Linux!

Основано на [`wg-easy v14`](https://github.com/wg-easy/wg-easy/tree/v14)

## Вход в веб-интерфейс
Если установили имя пользователя и пароль
<p align="center"> <img src="./assets/logon.png" width="404" /> </p>

## Созданные и подключенные клиенты
<p align="center"> <img src="./assets/screen.png" width="700" /> </p>

## Создание клиента с типом конфигурации WireGuard
Обязательно указать имя клиента
<p align="center"> <img src="./assets/newclientwg.png" width="600" /> </p>

## Создание клиента с типом конфигурации AmneziaWG
Обязательно указать имя клиента и параметры J (вручную или из пресетов)
<p align="center"> <img src="./assets/newclientawg.png" width="500" /> </p>
<p align="center"> <img src="./assets/newclientawgp.png" width="500" /> </p>

## Изменение типа конфигурации клиента
<p align="center"> <img src="./assets/clientwgonawg.png" width="400" /> </p>
<p align="center"> <img src="./assets/clientwgonawgp.png" width="400" /> </p>

## Изменение ранее заданных параметров J для типа конфигурации AmneziaWG
<p align="center"> <img src="./assets/clientawg.png" width="400" /> </p>
<p align="center"> <img src="./assets/clientawgj.png" width="400" /> </p>

## Изменение ранее заданного времени истечения клиента
<p align="center"> <img src="./assets/clientexpiresat.png" width="400" /> </p>
<p align="center"> <img src="./assets/clientexpiresatd.png" width="400" /> </p>
<p align="center"> <img src="./assets/clientexpiresatr.png" width="400" /> </p>



## Функции
* Все в одном: WireGuard + AmneziaWG + веб-интерфейс.
* Простая установка, простое использование.
* Список, создание, редактирование, удаление, включение и отключение клиентов.
* Время истечения клиента, при котором автоматичски произойдет отключение клиента.
* QR-код клиента для подключения конфигурации.
* Загрузка (скачивание) файла конфигурации клиента (для отправки клиенту) с припиской в конце файла типа конфигурации WireGuard или AmneziaWG.
* Статистика трафика по подключенным клиентам.
* Месячная статистика трафика по подключенным клиентам.
* Диаграммы Tx/Rx для каждого подключенного клиента.
* Поддержка Gravatar.
* Автоматический, светлый/темный режим темы.
* Поддержка английского и русского языка.
* Клиенты изолированы друг от друга.

## Требования

* Хост с ядром, поддерживающим WireGuard - все современные ядра.
* Хост с установленным Docker.
* Рекомендуется Ubuntu 24.04 (рабочая версия)

## Установка

### 1. Установите Докер

Если вы еще не установили Docker, установите его, выполнив:

```bash
curl -sSL https://get.docker.com | sh
sudo usermod -aG docker $(whoami)
exit
```
И войдите снова.

или 

```bash
sudo apt update
sudo apt install docker.io docker-compose
```

### 2. Запустите WireGuard and AmneziaWG Easy

WireGuard and AmneziaWG Easy рекомендуется запускать с помощью Docker Compose - загрузите фаил [`docker-compose.yml`](docker-compose.yml), внесите нужные Вам изменения (см. [Параметры](https://github.com/nonenulldev404/wgandamneziawg-easy?tab=readme-ov-file#%D0%BF%D0%B0%D1%80%D0%B0%D0%BC%D0%B5%D1%82%D1%80%D1%8B) и запустите `docker compose up -d //Необходимо запускать из каталога, где находится файл docker-compose.yml или указать путь к файлу docker-compose.yml`.

:exclamation: Обязательно:

Установите USERNAME_HASH и PASSWORD_HASH - хеш имени пользователя и пароля bcrypt для входа в веб-интерфейс. Смотрите [How_to_generate_an_bcrypt_hash.md](./How_to_generate_an_bcrypt_hash.md) для получения информации о том, как сгенерировать хэш.

Веб-интерфейс будет доступен на http://0.0.0.0:51821 или https://0.0.0.0:51821 - в зависимости от предпочтений



## Параметры

| Env (Переменные) | Значение по умолчанию | Пример изменения | Описание                                                                                                                                          |
| - | - | - |------------------------------------------------------------------------------------------------------------------------------------------------------|
| `PORT` | `51821` | `6789` | TCP-порт для веб-интерфейса.                                                                                                                                 |
| `WEBUI_HOST` | `0.0.0.0` | `localhost` | IP-адрес или доменное имя, к которому привязан веб-интерфейс.                                                                                                                          |
| `PROTOCOL` | `http` | `https` | Если будет ошибка с сертифкатами, так же поднимется http, путь до сертификатов для https нужно добавить в разделе volumes в файле [`docker-compose.yml`](docker-compose.yml). Сертификаты принимаются с названием и форматом только таким server.crt и server.key |
| `USERNAME_HASH` | Отсутствует | `$2y$05$Ci...` | Если установлено, требуется имя пользователя при входе в веб-интерфейс. Смотрите [How to generate an bcrypt hash.md](./How_to_generate_an_bcrypt_hash.md) для того, чтобы узнать, как сгенерировать хэш. |
| `PASSWORD_HASH` | Отсутствует | `$2y$05$Ci...` | Если установлено, требуется пароль при входе в веб-интерфейс. Смотрите [How to generate an bcrypt hash.md](./How_to_generate_an_bcrypt_hash.md) для того, чтобы узнать, как сгенерировать хэш. |
| `WG_HOST` | - | `vpn.myserver.com или IP-адрес` | Публичное имя хоста или IP-адрес Вашего VPN-сервера.                                                                                                              |
| `WG_DEVICE` | `eth0` | `ens6f0` | Ethernet-устройство, через которое должен пересылаться трафик WireGuard and AmneziaWG внутри контейнера Docker.                                                                                   |
| `WG_PORT` | `51820` | `12345` | Публичный UDP порт Вашего VPN-сервера. WireGuard and AmneziaWG будет прослушивать его (в противном случае — порт по умолчанию) внутри контейнера Docker.                                 |
| `WG_CONFIG_PORT`| `51820` | `12345` | Порт UDP, используемый в [Home Assistant Plugin](https://github.com/adriy-be/homeassistant-addons-jdeath/tree/main/wgeasy)                               
| `WG_MTU` | `null` | `1420` | MTU, который будут использовать клиенты. Сервер использует WG MTU по умолчанию.                                                                                            |
| `WG_PERSISTENT_KEEPALIVE` | `0` | `25` | Значение в секундах для поддержания "соединения" открытым. Если это значение равно 0, то соединения не будут поддерживаться.                                            |
| `WG_DEFAULT_ADDRESS` | `10.8.0.x` | `10.6.0.x` | Диапазон IP-адресов клиентов (Вашей сети VPN).                                                                                                                            |
| `WG_DEFAULT_DNS` | `1.1.1.1` | `8.8.8.8,8.8.4.4,9.9.9.9,1.1.1.1,1.0.0.1` | DNS-сервер, который клиенты будут использовать. Если задано пустое значение, клиенты не будут использовать DNS.                                                                    |
| `WG_ALLOWED_IPS` | `0.0.0.0/0, ::/0` | `192.168.15.0/24, 10.0.1.0/24` | Разрешенные IP-адреса, которые будут использовать клиенты.                                                                                                                        |
| `WG_PRE_UP` | `...` | - | Перед поднятием интерфейса - Подготовка (например, настройка firewall). Смотрите [config.js](https://github.com/nonenulldev404/wgandamneziawg-easy/blob/wgandamneziawg-easy/src/config.js) для значения по умолчанию.                                             |
| `WG_POST_UP` | `...` | `iptables ...` | После поднятия интерфейса - Роутинг, NAT, правила iptables и т.п. Смотрите [config.js](https://github.com/nonenulldev404/wgandamneziawg-easy/blob/wgandamneziawg-easy/src/config.js) для значения по умолчанию.                               |
| `WG_PRE_DOWN` | `...` | - | Перед остановкой интерфейса - Очистка или подготовка к отключению. Смотрите [config.js](https://github.com/nonenulldev404/wgandamneziawg-easy/blob/wgandamneziawg-easy/src/config.js) для значения по умолчанию.                                             |
| `WG_POST_DOWN` | `...` | `iptables ...` | 	После остановки интерфейса - Финальная очистка. Смотрите [config.js](https://github.com/nonenulldev404/wgandamneziawg-easy/blob/wgandamneziawg-easy/src/config.js) для значения по умолчанию.                                        |
| `LANG` | `en` | `ru` | Язык веб-интерфейса (поддерживается: en, ru).                                        |                                                                                                     |
| `UI_CHART_TYPE` | `0` | `1` | UI_CHART_TYPE=0 # Диаграммы отключены, UI_CHART_TYPE=1 # Линейная диаграмма, UI_CHART_TYPE=2 # Диаграмма с областями, UI_CHART_TYPE=3 # Столбчатая диаграмма.                           |

> Если вы меняете WG_PORT, не забудьте также изменить открытый порт PORT.

> Оставшиеся параметры обфускации - S1, S2, H1, H2, H3, H4 - заданы жестко и неизменяемы. Имеют значение: S1= 0, S2 = 0, H1 = 1, H2 = 2, H3 = 3, H4 = 4 - условие обфускации Amnezia. Если изменить данные параметры, ничего работать не будет.

## Обновление

Чтобы обновиться до последней версии, просто запустите:

```bash
cd /папка/с/docker-compose.yml
docker compose pull
docker compose up -d
```

или

```bash
docker stop wgandamneziawg-easy
docker rm wgandamneziawg-easy
docker pull ghcr.io/nonenulldev404/wgandamneziawg-easy:latest
docker compose up -d //Необходимо запускать из каталога, где находится файл docker-compose.yml или указать путь к файлу docker-compose.yml
```
