# adt-cli — Tài liệu tham khảo CLI (tiếng Việt)

> File này là tài liệu **bổ sung**, viết bằng tiếng Việt, liệt kê đầy đủ mọi lệnh CLI của `adt-cli`: cú pháp, cách dùng và mục đích — bao gồm cả các nhóm lệnh mới (`adt object pull`, `adt lint skeleton|metrics|refs|format`, `adt context build|inspect|budget`) hiện **chưa có** trong `README.md`.
> `README.md` (tiếng Anh) và `CLAUDE.md` (ngữ cảnh cho AI agent) vẫn là nguồn tham khảo chính cho phần đã có — file này không thay thế, chỉ bổ sung và dịch.

---

## Mục lục

1. [Tổng quan dự án](#1-tổng-quan-dự-án)
2. [Cài đặt & thiết lập](#2-cài-đặt--thiết-lập)
3. [Tùy chọn toàn cục](#3-tùy-chọn-toàn-cục-global-options)
4. [Biến môi trường](#4-biến-môi-trường)
5. [Sơ đồ cây lệnh tổng quan](#5-sơ-đồ-cây-lệnh-tổng-quan)
6. Chi tiết từng nhóm lệnh
   - [6.1 `adt auth`](#61-adt-auth--quản-lý-thông-tin-đăng-nhập--profile)
   - [6.2 `adt system`](#62-adt-system--thông-tin-hệ-thống--discovery)
   - [6.3 `adt object`](#63-adt-object--quản-lý-object-repository)
   - [6.4 `adt data`](#64-adt-data--xem-dữ-liệu-sql--ddic)
   - [6.5 `adt service`](#65-adt-service--service-binding)
   - [6.6 `adt cts`](#66-adt-cts--change--transport-system)
   - [6.7 `adt trace`](#67-adt-trace--runtime-trace)
   - [6.8 `adt atc`](#68-adt-atc--abap-test-cockpit)
   - [6.9 `adt debug`](#69-adt-debug--debugger)
   - [6.10 `adt http`](#610-adt-http--request-tổng-quát--chạy-file-http)
   - [6.11 `adt lint`](#611-adt-lint--phân-tích-tĩnh-offline-abaplint)
   - [6.12 `adt context`](#612-adt-context--tạo-context-bundle-cho-llm)
7. [File cấu hình](#7-file-cấu-hình)
8. [Exit codes](#8-exit-codes)
9. [Quick start / Recipes tổng hợp](#9-quick-start--recipes-tổng-hợp)

---

## 1. Tổng quan dự án

`adt-cli` là một **CLI Node.js, hướng tới agent (agent-friendly)**, đóng vai trò là adapter cụ thể cho SAP **ABAP Development Tools (ADT) HTTP API** (`/sap/bc/adt/*`). Nó là cầu nối giữa lớp dịch vụ `@octo/service` (Octo platform) và một hệ thống SAP ABAP (on-premise hoặc BTP).

**Hai nhóm người dùng mục tiêu:**
- **Coding agent**: mọi bước thực thi được log ra `stderr`, kết quả (data) ra `stdout`; exit code dự đoán được; có sẵn cổng thoát `adt http request` cho các trường hợp chưa có lệnh riêng.
- **Developer**: thiết lập credential nhanh (Basic + BTP OAuth refresh-token), quản lý profile, các "one-shot recipe" như tạo program + push source + activate trong một lệnh.

**Stack chính:**
- Node.js ≥ 18.17 (dùng `fetch` toàn cục)
- `commander` — framework CLI
- `fast-xml-parser` — chuyển đổi XML ↔ JSON
- `undici` — HTTP client, hỗ trợ proxy doanh nghiệp
- `@abaplint/core` — phân tích tĩnh ABAP offline (dùng cho `adt lint` và `adt context`)

**Entry point:** `bin/adt.js` → `src/cli.js`
**Binary names:** `adt`, `adt-cli`

---

## 2. Cài đặt & thiết lập

```bash
cd adt-cli
npm install
npm link        # tùy chọn: để dùng lệnh `adt` toàn cục
```

Hoặc chạy trực tiếp không cần `npm link`:

```bash
node bin/adt.js --help
```

> Yêu cầu **Node.js ≥ 18.17** (do dùng `fetch` toàn cục có sẵn từ phiên bản này).

### Thiết lập profile (bắt buộc trước khi dùng mọi lệnh khác)

Có 3 kiểu profile: `basic`, `oauth`, `destination`. Chọn một trong số các lệnh sau:

```bash
# 1) Hệ thống on-prem, đăng nhập bằng user/password (Basic auth)
adt auth login basic --name dev \
  --url https://abap:44300 --user DEVELOPER --password '****'

# 2) BTP / Steampunk qua OAuth refresh-token
adt auth login oauth --name cloud \
  --url https://abap.host --login-url https://uaa.host \
  --client-id sb-... --client-secret '****' --refresh-token '****'

# 3) BTP Destination (Principal Propagation / SSO)
adt auth login destination --name btp --destination MY_ABAP

# Kiểm tra kết nối
adt system discovery
```

---

## 3. Tùy chọn toàn cục (Global options)

Các flag này áp dụng cho **mọi** lệnh con (đặt trước hoặc sau nhóm lệnh):

| Flag | Mục đích |
|------|---------|
| `-V, --version` | In phiên bản CLI rồi thoát. |
| `-p, --profile <name>` | Chọn profile (đè lên `ADT_PROFILE`). |
| `-v, --verbose` | In method/URL/status của mọi HTTP request ra `stderr`. |
| `--debug` | Log debug — kèm header (đã ẩn thông tin nhạy cảm) và preview body. |
| `-q, --quiet` | Chỉ in lỗi. |
| `--insecure` | Bỏ qua kiểm tra TLS certificate. |
| `--accept <mime>` | Đè header `Accept` của request. |
| `--raw` | In body trả về nguyên dạng, không parse XML→JSON. |
| `--json` | Bắt buộc kết quả đầu ra dạng JSON (mặc định JSON nếu response là XML). |
| `--output <file>` | Ghi body kết quả ra file thay vì in `stdout`. |
| `--user-jwt <token>` | JWT để forward (dùng cho profile kiểu `destination`, Principal Propagation). |
| `--iss <url>` | Issuer URL của subscriber tenant (lookup destination theo tenant). |

---

## 4. Biến môi trường

| Biến | Tác dụng |
|------|---------|
| `ADT_PROFILE` | Profile mặc định (bị `--profile` đè lên). |
| `ADT_BEARER` | Đặt `Authorization: Bearer <token>` trực tiếp, bỏ qua refresh OAuth. |
| `ADT_BASIC` | Đặt `Authorization: Basic <base64>` trực tiếp, bỏ qua tra profile. |
| `ADT_CLI_HOME` | Thư mục chứa config (mặc định `~/.adt-cli`). |
| `ADT_USER_JWT` | Giá trị mặc định cho `--user-jwt`. |
| `ADT_ISS` | Giá trị mặc định cho `--iss`. |
| `NO_COLOR` | Tắt màu ANSI trong log. |
| `destinations` | Mảng JSON các destination cục bộ, dùng cho profile kiểu `destination` (dev local). |
| `VCAP_SERVICES` | Service binding của BTP (tự động được CLI đọc). |
| `HTTPS_PROXY` / `HTTP_PROXY` | Proxy doanh nghiệp (qua `undici.ProxyAgent`). |

---

## 5. Sơ đồ cây lệnh tổng quan

```
adt
├── auth
│   ├── login            basic | oauth | destination | test
│   ├── profile          list | show | use | delete | path | set-lint-config
│   └── destinations     list | show | test      (alias: dest)
├── system
│   ├── discovery | core-discovery | graph | feeds
│   ├── object-types | type-structure
│   └── users | dumps
├── object
│   ├── create           program|class|interface|include|fgroup|fmodule|finclude
│   │                     |ddl|dcl|ddlx|ddla|package|table|service-def
│   │                     |service-binding|dtel|msag|auth-field|auth-object
│   ├── create-types | create-generic | validate
│   ├── structure | properties | source | versions
│   ├── set-source | lock | unlock
│   ├── activate | inactive | delete
│   └── pull              ← mirror cả package về local (abapGit naming)
├── data                  sql | ddic | ddic-meta
├── service               binding | odata-v2
├── cts                   config-metadata | configurations | configuration
│                         | save-configuration | list
├── trace                 list | requests | hitlist | db | statements
│                         | parameters | create | delete
├── atc                   activate | run | worklist | check | customizing | users
├── debug                 discovery | status | listen | settings
│                         | breakpoint set|delete
├── http                  request (alias req) | list | run
├── lint                  object | file | package | skeleton | metrics | refs | format
└── context               build | inspect | budget
```

---

## 6.1 `adt auth` — Quản lý thông tin đăng nhập & profile

> File hiện thực: `src/commands/login.js`, `src/commands/profile.js`

### `adt auth login basic`

```bash
adt auth login basic --url <url> --user <user> [--password <pwd>] [--name <profile>] \
  [--client <sap-client>] [--language <lang>] [--insecure] [--no-verify]
```

- **Mục đích:** Lưu một profile Basic-auth và xác minh ngay bằng cách gọi `/sap/bc/adt/discovery`. Nếu không truyền `--password`, CLI sẽ hỏi (ẩn ký tự khi nhập).
- **Options:**
  | Flag | Ý nghĩa |
  |---|---|
  | `--url <url>` (bắt buộc) | URL gốc ABAP, ví dụ `https://abap:44300` |
  | `--user <user>` (bắt buộc) | User ABAP, ví dụ `DEVELOPER` |
  | `--password <pwd>` | Mật khẩu (nếu thiếu sẽ hỏi) |
  | `--name <profile>` | Tên profile (đè `--profile`/global) |
  | `--client <client>` | `sap-client`, ví dụ `100` |
  | `--language <lang>` | `sap-language`, ví dụ `EN` |
  | `--insecure` | Bỏ kiểm tra TLS |
  | `--no-verify` | Không gọi discovery để xác minh |

### `adt auth login oauth`

```bash
adt auth login oauth --url <abap-url> --login-url <uaa-url> --client-id <sb-...> \
  [--client-secret <secret>] [--refresh-token <token>] [--name <profile>] \
  [--client <sap-client>] [--language <lang>] [--insecure] [--no-verify]
```

- **Mục đích:** Lưu profile OAuth (refresh-token grant) cho SAP BTP/Steampunk, xác minh ngay. CLI tự refresh access token khi còn < 30s là hết hạn.
- **Options chính:** `--url` (URL ABAP, không phải UAA), `--login-url` (URL UAA/login), `--client-id`, `--client-secret`, `--refresh-token` (đều bắt buộc trừ secret/refresh-token có thể nhập tay), `--client`, `--language`, `--insecure`, `--no-verify`.

### `adt auth login destination`

```bash
adt auth login destination --destination <name> [--name <profile>] \
  [--service-binding <jsonOrPath>] [--iss <url>] [--user-jwt <token>] \
  [--client <client>] [--language <lang>] [--insecure] [--no-verify]
```

- **Mục đích:** Lưu profile lấy URL + auth từ **BTP Destination** tại thời điểm chạy (không lưu credential tĩnh). Thứ tự tra cứu: `process.env.destinations` → `profile.serviceBindingJson` → `VCAP_SERVICES.destination`.
- **Options đáng chú ý:**
  | Flag | Ý nghĩa |
  |---|---|
  | `--destination <name>` (bắt buộc) | Tên destination |
  | `--service-binding <jsonOrPath>` | JSON inline hoặc đường dẫn file chứa service binding của destination service |
  | `--iss <url>` | Issuer URL của subscriber tenant (multi-tenant) |
  | `--user-jwt <token>` | JWT người dùng cho Principal Propagation |
  | `--client` / `--language` | Đè giá trị lấy từ destination |

### `adt auth login test`

```bash
adt auth login test [--name <profile>]
```
- **Mục đích:** Kiểm tra lại một profile đã lưu bằng cách gọi `/sap/bc/adt/discovery`. Exit code `0` = thành công, `2` = thất bại.

### `adt auth profile <verb>`

| Lệnh | Mục đích |
|---|---|
| `adt auth profile list` (alias `ls`) | Liệt kê tất cả profile đã lưu, đánh dấu profile mặc định. |
| `adt auth profile show [name]` | Hiển thị cấu hình đã resolve của một profile (ẩn secret). Không truyền `name` → dùng profile mặc định. |
| `adt auth profile use <name>` | Đặt `<name>` làm profile mặc định. |
| `adt auth profile delete <name>` (alias `rm`) | Xóa một profile khỏi config. |
| `adt auth profile path` | In đường dẫn file config (`~/.adt-cli/config.json`). |
| `adt auth profile set-lint-config <configPath> [--name <profile>] [--clear]` | Gắn một file `abaplint.json`/`.jsonc` vào profile để `adt lint` tự dùng. `--clear` để gỡ liên kết. |

### `adt auth destinations` (alias `dest`)

> Nhóm lệnh **kiểm tra/inspect** destination, không tạo profile.

| Lệnh | Mục đích |
|---|---|
| `adt auth destinations list` | Liệt kê: destination cục bộ từ env `destinations`, các service binding `VCAP_SERVICES.destination`, và (nếu kết nối được) toàn bộ destination từ destination service. `--no-remote` để bỏ qua phần remote. Options thêm: `--service-binding <jsonOrPath>`, `--user-jwt <token>`. |
| `adt auth destinations show <name>` | Resolve một destination theo tên, in kết quả đã **lược bỏ thông tin nhạy cảm**. Options: `--service-binding`, `--iss`, `--user-jwt`. |
| `adt auth destinations test <name>` | Resolve destination rồi gọi `/sap/bc/adt/discovery` vào URL kết quả để xác minh thực tế kết nối được. Options: `--service-binding`, `--iss`, `--insecure`. |

---

## 6.2 `adt system` — Thông tin hệ thống & discovery

> File hiện thực: `src/commands/discovery.js`

| Lệnh | Mục đích |
|---|---|
| `adt system discovery` | `GET /sap/bc/adt/discovery` — service document gốc, danh sách các collection ADT hỗ trợ. |
| `adt system core-discovery` | `GET /sap/bc/adt/core/discovery` — đồng thời "mồi" (prime) CSRF token cho các request thay đổi dữ liệu sau đó. |
| `adt system graph` | `GET /sap/bc/adt/compatibility/graph` — thông tin tương thích của server. |
| `adt system feeds` | `GET /sap/bc/adt/feeds` — atom feed các feed khả dụng. |
| `adt system object-types [--name <name>] [--max <n>] [--data <data>]` | `GET /sap/bc/adt/repository/informationsystem/objecttypes`. `--name` mặc định `*`, `--max` mặc định `999`, `--data` mặc định `usedByProvider`. |
| `adt system type-structure` | `POST /sap/bc/adt/repository/typestructure`. |
| `adt system users` | `GET /sap/bc/adt/system/users` — danh sách user hệ thống. |
| `adt system dumps [--user <user>] [--top <n>]` | Truy vấn short dump từ `/sap/bc/adt/runtime/dumps`. `--user` lọc theo người chịu trách nhiệm, `--top` mặc định `50`. |

---

## 6.3 `adt object` — Quản lý object repository

> File hiện thực: `src/commands/create.js` (tạo object), `src/commands/objects.js` (đọc/sửa/lifecycle), `src/commands/pull.js` (mirror package)

### `adt object create <kind> <name>` — Tạo object mới

```bash
adt object create <kind> <name> [options chung] [options theo kind]
```

**Options chung (mọi kind):**

| Flag | Ý nghĩa |
|---|---|
| `--description <text>` | Mô tả ngắn (`adtcore:description`) |
| `--responsible <user>` | `adtcore:responsible` (mặc định = user của profile) |
| `--transport <id>` | Số transport request (`corrNr`) |
| `--validate-only` | Chỉ chạy validate tên rồi dừng |
| `--no-validate` | Bỏ qua bước validate |
| `--source-file <file>` | Sau khi tạo: lock + PUT source từ file (stateful) |
| `--source-stdin` | Sau khi tạo: đọc source từ stdin rồi PUT |
| `--activate` | Sau khi tạo (và push source nếu có): activate luôn |

**Bảng các `<kind>` (alias) được hỗ trợ:**

| Alias | typeId ADT | Flag cha | Độ dài tên tối đa | Ghi chú |
|---|---|---|---|---|
| `program` | `PROG/P` | `--package` | 30 | ABAP program |
| `class` | `CLAS/OC` | `--package` | 30 | Class |
| `interface` | `INTF/OI` | `--package` | 30 | Interface |
| `include` | `PROG/I` | `--package` | 30 | Include |
| `fgroup` | `FUGR/F` | `--package` | 26 | Function group |
| `fmodule` | `FUGR/FF` | `--group` | — | Function module trong group |
| `finclude` | `FUGR/I` | `--group` | — | Include của function group |
| `ddl` | `DDLS/DF` | `--package` | 30 | CDS Data Definition |
| `dcl` | `DCLS/DL` | `--package` | 30 | CDS Access Control |
| `ddlx` | `DDLX/EX` | `--package` | 30 | CDS Metadata Extension |
| `ddla` | `DDLA/ADF` | `--package` | 30 | CDS Annotation Definition |
| `package` | `DEVC/K` | `--super-package` | 30 | Package |
| `table` | `TABL/DT` | `--package` | 16 | Bảng DDIC |
| `service-def` | `SRVD/SRV` | `--package` | 30 | Service Definition |
| `service-binding` | `SRVB/SVB` | `--package` + `--service` | 30 | Service Binding |
| `dtel` | `DTEL/DE` | `--package` | 30 | Data Element |
| `msag` | `MSAG/N` | `--package` | 20 | Message Class |
| `auth-field` | `AUTH` | `--package` | 10 | Authorization Field |
| `auth-object` | `SUSO/B` | `--package` | 10 | Authorization Object |

**Options đặc thù theo kind:**

- **`package` (`DEVC/K`):** `--super-package <pkg>`, `--swcomp <comp>`, `--transport-layer <layer>`, `--package-type <kind>` (`development|structure|main`, mặc định `development`)
- **`fmodule`, `finclude`:** `--group <fgroup>` (bắt buộc — function group cha)
- **`service-binding`:** `--service <name>` (bắt buộc — tên service definition), `--binding-type <type>` (mặc định `ODATA`), `--category <0|1>` (`0` = Web API, `1` = UI, mặc định `0`)

**Ví dụ:**

```bash
# Tạo program, push source, activate trong 1 lệnh
adt object create program ZHELLO --package $YMU_PKG --description "Hello" \
  --source-file zhello.abap --activate

# Tạo class
adt object create class ZCL_FOO --package $YMU_PKG --description "My Class" --activate

# Function module trong function group
adt object create fmodule Z_FM --group ZGRP --description "Function Module"

# Service binding OData v2
adt object create service-binding YMU_SB --package $YMU_PKG \
  --service YMU_SRVD --binding-type ODATA --category 0
```

### `adt object create-types`

```bash
adt object create-types
```
- **Mục đích:** In danh sách tất cả `<kind>` alias mà CLI biết cách tạo, kèm `typeId`, parent flag, độ dài tên tối đa và path tạo object — dùng để tra cứu nhanh trước khi gọi `create`.

### `adt object create-generic`

```bash
adt object create-generic --type <typeId> --name <name> [options]
```
- **Mục đích:** Tạo object bằng `typeId` ADT trực tiếp (thay vì alias `<kind>`), dùng khi cần một loại object chưa có alias riêng.
- **Options:** `--type <typeId>` (bắt buộc, vd `PROG/P`, `CLAS/OC`), `--name <name>` (bắt buộc), cùng các flag `--package`, `--group`, `--super-package`, `--swcomp`, `--transport-layer`, `--package-type`, `--service`, `--binding-type`, `--category`, `--responsible`, `--transport`, `--description`, `--validate-only`, `--no-validate`, `--source-file`, `--source-stdin`, `--activate` (như trên).

### `adt object validate <kind> <name>`

```bash
adt object validate <kind> <name> [--package <pkg>] [--group <fgroup>] \
  [--super-package <pkg>] [--swcomp <comp>] [--transport-layer <layer>] \
  [--package-type <kind>] [--description <text>]
```
- **Mục đích:** Chạy validate tên phía server cho một object **chưa tạo**, để kiểm tra trước khi thực sự `create`.

### Đọc / sửa / lifecycle object (`src/commands/objects.js`)

| Lệnh | Mục đích |
|---|---|
| `adt object structure <objectUrl> [--version <v>]` | Đọc metadata cấu trúc của object đã tồn tại. `--version`: `active`\|`inactive`\|`workingArea`. |
| `adt object properties <uri>` | Đọc property values từ endpoint properties của object (truyền URI source, vd `/sap/bc/adt/.../source/main`). |
| `adt object source <objectUrl> [--include <name>] [--version <v>]` | Đọc source text của object. `--include` mặc định `main`. Tôn trọng `--output` toàn cục để lưu ra file. |
| `adt object versions <objectUrl> [--include <name>]` | Liệt kê lịch sử version (atom feed các revision) của object. |
| `adt object set-source <objectUrl> [--file <file> \| --source-stdin] [--include <name>] [--transport <id>] [--keep-locked] [--lock-handle <handle>]` | **Lock + PUT source + unlock** cho object (stateful). Nếu không truyền `--file`, đọc từ stdin. `--keep-locked` để không unlock cuối; `--lock-handle` dùng lock đã có sẵn. |
| `adt object activate <objectUrl> [--name <name>] [--main-include <uri>] [--no-preaudit]` | Activate object qua `/sap/bc/adt/activation`. `--name` mặc định lấy từ segment cuối của URL (uppercase). `--no-preaudit` đặt `preauditRequested=false`. **Exit code 1** nếu `success=false`. |
| `adt object delete <objectUrl> [--transport <id>] [--handle <h>]` | Xóa object (tự lock nếu chưa truyền `--handle`). |
| `adt object lock <objectUrl> [--mode <mode>]` | Lấy lock `MODIFY` trên object (hiếm khi cần dùng riêng lẻ). `--mode` mặc định `MODIFY`. |
| `adt object unlock <objectUrl> --handle <LOCK_HANDLE>` | Giải phóng lock đã lấy trước đó (handle lấy từ `adt object lock`). |
| `adt object inactive` | Liệt kê các object đang ở trạng thái inactive, chờ activate. |

### `adt object pull` — Mirror cả package về local

```bash
adt object pull --package <pkg> [--out <dir>] [--depth <n>] [--max <n>] \
  [--include-only <ids>] [--skip-types <ids>] [--no-dependencies] [--no-docs] \
  [--keep-going] [--skip-unsupported] [--namespace-prefixes <csv>] [--print-config]
```

- **Mục đích:** Tải (mirror) **toàn bộ một package ABAP** (đệ quy theo sub-package) về một thư mục local, đặt tên theo convention **abapGit** (vd `zcl_foo.clas.abap`). Đây là bước **offline-first** — pull một lần, phân tích nhiều lần (dùng cho `adt lint`, `adt context build`...).
- **Options:**
  | Flag | Ý nghĩa |
  |---|---|
  | `--package <pkg>` (bắt buộc) | Tên package ABAP, vd `ZABAP_GENERATOR` |
  | `--out <dir>` | Thư mục output (mặc định `./<package-lowercase>`) |
  | `--depth <n>` | Đệ quy sub-package đến độ sâu N. `0` = chỉ root, bỏ trống = không giới hạn |
  | `--max <n>` | Số object tối đa (mặc định `500`) |
  | `--include-only <ids>` | CSV các `typeId` — **thay thế hoàn toàn** danh sách pull-config |
  | `--skip-types <ids>` | CSV các `typeId` cần loại trừ (trừ khỏi danh sách hiệu lực) |
  | `--no-dependencies` | Không tải where-used graph (`.dependencies.json`) |
  | `--no-docs` | Không tải long-text docs (dành cho phase sau) |
  | `--keep-going` | Tiếp tục nếu một fetch lỗi (mặc định `true`) |
  | `--skip-unsupported` | Ẩn warning với các `typeId` không xác định |
  | `--namespace-prefixes <csv>` | CSV các tiền tố tên object cần giữ (đè pull-config); vd `Z,Y,/RB`. Rỗng (`""`) = không pull gì cả |
  | `--print-config` | In cấu hình pull hiệu lực (đã resolve) dạng JSON rồi thoát, **không** gọi SAP |

- **Kết quả ghi ra `--out`:**
  - Các file source theo naming abapGit
  - `.abap-package.json` — manifest **schema v3**: `inventory[]` đầy đủ cho mọi node đã duyệt, mỗi entry có `status` ∈ `pulled | not-in-config | not-in-namespace | unknown-type | fetch-failed`
  - `.dependencies.json` — các cạnh where-used (`{ from, to, kind: "usedBy", external }`) cho các object đã pull (bỏ qua nếu `--no-dependencies`)

- **Ví dụ:**
  ```bash
  # Mirror toàn bộ package, mặc định
  adt object pull --package ZABAP_GENERATOR

  # Xem trước cấu hình pull (typeIds + namespace) sẽ áp dụng, không gọi SAP
  adt object pull --package ZPK_X --print-config

  # Hành vi "cũ": chỉ code ABAP, không DDIC, không đệ quy, không deps
  adt object pull --package X --depth 0 --no-dependencies \
    --include-only CLAS/OC,INTF/OI,PROG/P,PROG/I,FUGR/F,FUGR/FF,FUGR/I
  ```

---

## 6.4 `adt data` — Xem dữ liệu SQL & DDIC

> File hiện thực: `src/commands/data.js`

| Lệnh | Mục đích |
|---|---|
| `adt data sql <query...> [--rows <n>]` | Chạy một câu **ABAP SQL** tự do và in preview kết quả dạng bảng. `--rows` mặc định `100`. |
| `adt data ddic <entity> [--rows <n>] [--where <sql>]` | Preview dữ liệu của một entity DDIC (bảng hoặc CDS view), vd `/DMO/TRAVEL`. `--where` thêm điều kiện WHERE. |
| `adt data ddic-meta <entity>` | Đọc metadata cột (column) của một entity DDIC. |

**Ví dụ:**
```bash
adt data sql 'SELECT CARRIER_ID, CUSTOMER_ID FROM /DMO/BOOKING WHERE BOOKING_ID = 0005' --rows 5
adt data ddic /DMO/TRAVEL --rows 20 --where "STATUS = 'O'"
adt data ddic-meta /DMO/TRAVEL
```

---

## 6.5 `adt service` — Service binding

> File hiện thực: `src/commands/bindings.js`

| Lệnh | Mục đích |
|---|---|
| `adt service binding <name>` | `GET /sap/bc/adt/businessservices/bindings/<name>` — đọc thông tin một service binding. |
| `adt service odata-v2 <binding> --service <name> --service-def <def> [--version <ver>]` | Đọc chi tiết service OData v2 của một binding. `--service` và `--service-def` bắt buộc, `--version` mặc định `0001`. |

---

## 6.6 `adt cts` — Change & Transport System

> File hiện thực: `src/commands/transports.js`

| Lệnh | Mục đích |
|---|---|
| `adt cts config-metadata` | `GET /sap/bc/adt/cts/transportrequests/searchconfiguration/metadata`. |
| `adt cts configurations` | Liệt kê các cấu hình tìm kiếm transport đã lưu. |
| `adt cts configuration <configId>` | Đọc một cấu hình tìm kiếm transport theo id. |
| `adt cts save-configuration <configId> --etag <e> --file <xml>` | Cập nhật cấu hình (PUT có `If-Match: <etag>`). `--etag` lấy từ lần đọc trước, `--file` là body XML. |
| `adt cts list --config <configId> [--no-targets]` | Liệt kê các transport theo một cấu hình tìm kiếm (`configUri`). `--no-targets` để bỏ `targets=true`. |

---

## 6.7 `adt trace` — Runtime trace

> File hiện thực: `src/commands/traces.js`

| Lệnh | Mục đích |
|---|---|
| `adt trace list [--user <user>]` | `GET /sap/bc/adt/runtime/traces/abaptraces` — liệt kê các trace đã ghi. |
| `adt trace requests [--user <user>]` | `GET .../abaptraces/requests` — liệt kê các request đã trace. |
| `adt trace hitlist <traceId> [--system-events]` | Lấy hitlist (thống kê thời gian) của một trace. |
| `adt trace db <traceId> [--system-events]` | Lấy danh sách truy vấn database của một trace (`--system-events` mặc định `true`). |
| `adt trace statements <traceId> [--id <n>] [--with-details] [--auto <pct>] [--system-events]` | Lấy call tree tổng hợp (statements) của trace. `--auto` (autoDrillDownThreshold) mặc định `80`. |
| `adt trace parameters --file <xml>` | POST file XML tham số trace, trả về `parametersId` để dùng cho `trace create`. |
| `adt trace create --description <text> --user <user> --client <client> --process-type <uri> --object-type <uri> --expires <iso> --parameters-id <uri> [--max-exec <n>] [--server <pattern>]` | Tạo một cấu hình trace mới. `--max-exec` mặc định `3`, `--server` mặc định `*`. |
| `adt trace delete <traceConfigId>` | Xóa một cấu hình trace. |

---

## 6.8 `adt atc` — ABAP Test Cockpit

> File hiện thực: `src/commands/atc.js`

| Lệnh | Mục đích |
|---|---|
| `adt atc activate <variant>` | Activate một ATC check variant (vd `DEFAULT`, `ABAPLINT_DEFAULT`, `S4_CLOUD_PLATFORM_CHECKS`), trả về `worklistId` để dùng cho `atc run`. |
| `adt atc run <worklistId> <objectUrl...> [--max <n>]` | Chạy worklist đã activate trên một/nhiều object URL. In ra `runId`. `--max` (số finding tối đa) mặc định `100`. |
| `adt atc worklist <runId> [--include-exempted] [--object-set <name>] [--timestamp <epoch>]` | Lấy worklist (các finding) của một run. **Exit code 1** nếu có error hoặc warning. |
| `adt atc check <objectUrl...> [--variant <id>] [--max <n>] [--include-exempted]` | **End-to-end**: activate variant + run + lấy worklist trong 1 lệnh. `--variant` mặc định `DEFAULT`, `--max` mặc định `100`. Thoát non-zero nếu có error/warning. |
| `adt atc customizing` | `GET /sap/bc/adt/atc/customizing` — đọc cấu hình ATC của hệ thống. |
| `adt atc users` | `GET /sap/bc/adt/system/users` — danh sách user (dùng để map findings theo người chịu trách nhiệm). |

**Ví dụ:**
```bash
# One-shot
adt atc check oo/classes/zcl_foo --variant DEFAULT

# Từng bước
WL=$(adt atc activate DEFAULT --json | jq -r .worklistId)
RUN=$(adt atc run $WL oo/classes/zcl_foo --json | jq -r .runId)
adt atc worklist $RUN
```

---

## 6.9 `adt debug` — Debugger

> File hiện thực: `src/commands/debugger.js`

| Lệnh | Mục đích |
|---|---|
| `adt debug discovery` | `GET /sap/bc/adt/debugger` — feed discovery của debugger. |
| `adt debug status [--mode <m>] [--user <user>]` | Lấy danh sách listener (trạng thái debug). `--mode` mặc định `user`. |
| `adt debug listen [--mode <m>] [--user <user>]` | Bắt đầu lắng nghe debug event (`POST listeners`; **long-poll**, request chạy lâu). |
| `adt debug settings (--file <file> \| --default)` | POST cấu hình debugger từ file XML, hoặc `--default` dùng cấu hình mẫu có sẵn trong `restcalls/debugger.http`. |
| `adt debug breakpoint set <objectUri> --line <n> [--program <P>] [--include <I>] [--user <U>] [--mode <m>]` | Đặt breakpoint tại dòng `--line` (1-based) trên một object URI (vd `/sap/bc/adt/programs/programs/zroman/source/main`). |
| `adt debug breakpoint delete <breakpointId> [--user <U>] [--mode <m>]` | Xóa breakpoint theo id (`KIND=0.SOURCETYPE=...LINE_NR=N`). |

---

## 6.10 `adt http` — Request tổng quát & chạy file `.http`

> File hiện thực: `src/commands/request.js`, `src/commands/runHttp.js`

### `adt http request <METHOD> <path>` (alias `req`)

```bash
adt http request <METHOD> <path> [-H 'Header: value' ...] [--content-type <mime>] \
  [--data <text> | --data-file <path>] [--no-fail]
```

- **Mục đích:** "Cổng thoát" (escape hatch) gọi HTTP trực tiếp đến ADT — dùng khi chưa có lệnh chuyên biệt. Auth, cookie, CSRF đều được CLI xử lý tự động.
- **Options:**
  | Flag | Ý nghĩa |
  |---|---|
  | `<METHOD>` (bắt buộc) | `GET`/`POST`/`PUT`/`DELETE`/`PATCH`/`HEAD` |
  | `<path>` (bắt buộc) | Path tương đối hoặc URL tuyệt đối |
  | `-H, --header <header...>` | Thêm header, vd `-H 'If-Match: 123'` |
  | `--content-type <mime>` | Content-Type của body |
  | `--data <text>` | Body dạng text |
  | `--data-file <path>` | Đọc body từ file (an toàn với binary) |
  | `--no-fail` | Không exit non-zero khi HTTP lỗi |

### `adt http list <file>` / `adt http run <file>`

| Lệnh | Mục đích |
|---|---|
| `adt http list <file>` | Parse và liệt kê tên các request bên trong một file `.http` (không thực thi). |
| `adt http run <file> [--var <kv...>] [--only <name>] [--continue-on-error] [--print-each]` | Thực thi các request trong file `.http` theo thứ tự. `--var key=value` set/override biến file; `--only <name>` chỉ chạy 1 request; `--continue-on-error` để tiếp tục khi có lỗi; `--print-each` in body của từng response. Biến profile (`baseUrl`, `url`, `user`, `password`, `loginUrl`, `clientId`, `clientSecret`, `refreshToken`, `client`) được tự động điền sẵn. |

---

## 6.11 `adt lint` — Phân tích tĩnh offline (abaplint)

> File hiện thực: `src/commands/lint.js`, dùng `src/abaplintAdapter.js` (bridge sang `@abaplint/core`).
> Loại object được hỗ trợ: `CLAS/OC`, `INTF/OI`, `PROG/P`, `PROG/I`.
> Exit code: `0` = không có vấn đề, `1` = có lỗi (error), `2` = chỉ có warning.

### `adt lint object <objectUrl>`

```bash
adt lint object <objectUrl> [--include <name>] [--config <path>]
```
- **Mục đích:** Tải source của một object qua ADT rồi lint bằng abaplint (offline). `--include` để chỉ lint 1 include cụ thể (bỏ qua các include khác). `--config` đè cấu hình abaplint của profile.

### `adt lint file <filePath>`

```bash
adt lint file <filePath> [--type <kind>] [--config <path>]
```
- **Mục đích:** Lint trực tiếp một file `.abap` **trên máy local**, **không cần** kết nối SAP. Tên file được tự động chuyển sang convention abapGit nếu cần (vd `ZCL_FOO.abap` → `zcl_foo.clas.abap`).
- **`--type`**: ép kiểu object — `class|interface|program|include` (nếu bỏ trống, CLI tự đoán theo tiền tố tên: `ZCL_`/`CL_` → class, `ZIF_`/`IF_` → interface, còn lại → program).

### `adt lint package <package>`

```bash
adt lint package <package> [--config <path>] [--max <n>] [--skip-unsupported] [--fix]
```
- **Mục đích:** Liệt kê toàn bộ object trong một package, tải source và lint **toàn bộ như một Registry duy nhất** (cho phép phân tích cross-object). `--max` mặc định `200`, `--skip-unsupported` (mặc định `true`) bỏ qua các typeId chưa hỗ trợ.
- **`--fix`**: áp dụng tất cả fix tự động (`getDefaultFix()`), in ra **source đã sửa** dạng JSON ở `stdout` — **không tự push lên SAP**, người dùng tự `adt object set-source` nếu muốn áp dụng.

### `adt lint skeleton`

```bash
adt lint skeleton (--object <url> | --package <pkg>) [--config <path>] [--max <n>]
```
- **Mục đích:** Trích xuất **JSON skeleton** (danh sách class kèm method/superclass/interface, interface, program) từ một object hoặc cả package — **rẻ hơn 5-10 lần** so với gửi raw ABAP, dùng để xây context cho LLM. `--max` (chỉ áp dụng với `--package`) mặc định `200`.

### `adt lint metrics`

```bash
adt lint metrics (--object <url> | --package <pkg>) [--top <n>] [--config <path>] [--max <n>]
```
- **Mục đích:** Tính **cyclomatic complexity** và **độ dài method** cho mọi class trong object/package — giúp phát hiện "god class" (`isGodClass`, > 30 method). `--top <n>` chỉ hiển thị N class có complexity cao nhất (`0` = tất cả, mặc định). `--max` (với `--package`) mặc định `200`.

### `adt lint refs`

```bash
adt lint refs --object <url> --line <n> --char <n> [--package <pkg>] [--config <path>] [--max <n>]
```
- **Mục đích:** Tìm tất cả nơi **tham chiếu (reference/where-used)** đến symbol tại vị trí dòng/cột chỉ định, dùng LSP `LanguageServer.references()` của abaplint. `--line`, `--char` đều **1-based** và **bắt buộc**. Truyền thêm `--package <pkg>` để load toàn bộ package, cho phép resolve tham chiếu **cross-object** (mặc định `--max 200` object được load).

### `adt lint format`

```bash
adt lint format (--object <url> | --package <pkg>) [--config <path>] [--max <n>]
```
- **Mục đích:** Chạy **PrettyPrinter** của abaplint trên một object hoặc cả package, in ra `stdout` dạng JSON (`{label, fileCount, files: [{filename, source}]}`). **Không** push ngược lên SAP — muốn áp dụng thì pipe kết quả và dùng `adt object set-source` thủ công. `--max` (với `--package`) mặc định `200`.

---

## 6.12 `adt context` — Tạo context bundle cho LLM

> File hiện thực: `src/commands/context.js`

### `adt context build`

```bash
adt context build --package <pkg> [--out <dir>] [--depth <n>] [--target-model <id>] \
  [--max-tokens <n>] [--include-source [glob]] [--strip [level]] [--with-docs] \
  [--with-where-used] [--types <list>] [--max <n>] [--namespace-prefixes <csv>] \
  [--clean | --no-overwrite] [--keep-going] [--dry-run] [--config <path>]
```

- **Mục đích:** Duyệt một package ABAP (và sub-package) và sinh ra **bộ context nhiều file cho mỗi package** (skeleton + metadata + "reading guide") — sẵn sàng để đưa vào LLM phân tích, thay cho việc gửi raw ABAP source.
- **Options chính:**
  | Flag | Ý nghĩa |
  |---|---|
  | `--package <pkg>` (bắt buộc) | Package ABAP gốc |
  | `--out <dir>` | Thư mục output gốc (mặc định `./adt-context`) |
  | `--depth <n>` | Đệ quy sub-package đến độ sâu N (`0` = chỉ root, bỏ trống = không giới hạn) |
  | `--target-model <id>` | Ghi lại LLM mục tiêu vào manifest (phục vụ tính token budget) |
  | `--max-tokens <n>` | Ngưỡng token mềm; nếu vượt sẽ "giảm cấp" nội dung |
  | `--include-source [glob]` | Kèm raw ABAP source cho các object khớp glob |
  | `--strip [level]` | Cắt bớt boilerplate khỏi source: `light\|medium\|aggressive` (không có giá trị = `medium`) |
  | `--with-docs` | Tải long-text doc của object & package |
  | `--with-where-used` | Tải tham chiếu inbound qua `/usageReferences` |
  | `--types <list>` | CSV nhóm typeId (`CLAS,INTF,PROG,FUGR,DDIC,CDS`) — *hiện chưa wire, chỉ cảnh báo* |
  | `--max <n>` | Số object tối đa mỗi package (mặc định `500`) |
  | `--namespace-prefixes <csv>` | CSV tiền tố tên object cần giữ (đè pull-config, cùng cơ chế với `adt object pull`); vd `Z,Y,/RB` |
  | `--clean` | Xóa `<out>/<PACKAGE>/` trước khi viết (không dùng cùng `--no-overwrite`) |
  | `--no-overwrite` | Dừng nếu `<out>/<PACKAGE>/` đã tồn tại |
  | `--keep-going` | Tiếp tục khi một object lỗi (mặc định: dừng ngay lỗi đầu tiên) |
  | `--dry-run` | Chỉ duyệt + phân loại, **không** fetch/viết file — in trước các hành động sẽ làm |
  | `--config <path>` | File cấu hình abaplint (đè cấu hình của profile) |

- **Exit code:** `1` nếu có package nào gặp lỗi; `0` nếu không (trường hợp "skip vì thư mục đã tồn tại" không tính là lỗi).

### `adt context inspect <bundleDir>`

```bash
adt context inspect <bundleDir> [--target-model <id>] [--max-tokens <n>]
```
- **Mục đích:** Kiểm tra một bundle đã build (truyền thư mục `<PACKAGE>` cụ thể, không phải `--out` gốc): tính lại số token ước lượng cho từng file/thư mục con, so với ngưỡng (soft cap) của `--target-model` (mặc định `claude-opus-4-7`), báo cáo bundle có "vừa" budget không.
- **Exit code:** `2` nếu tổng token vượt soft cap.

### `adt context budget`

```bash
adt context budget [--target-model <id>]
```
- **Mục đích:** In bảng kích thước context-window và soft cap (theo `SOFT_CAP_RATIO`) của các model LLM mà CLI biết — dùng để tham khảo khi chọn `--target-model`/`--max-tokens` cho `build`/`inspect`. `--target-model` để đánh dấu (highlight) một model trong bảng kết quả.

---

## 7. File cấu hình

### `~/.adt-cli/config.json` (mode `0600`)

Chứa các profile (có thể đổi vị trí qua `ADT_CLI_HOME`). 3 kiểu profile:

| Kiểu | Các field lưu |
|---|---|
| `basic` | `url`, `user`, `password` (base64, **không phải mã hóa**), `client`, `language`, `insecure` |
| `oauth` | `loginUrl`, `clientId`, `clientSecret` (base64), `refreshToken`, cache `accessToken`/`tokenExpiresAt`, `insecure` |
| `destination` | `destinationName`, `serviceBindingJson` (tùy chọn), `iss`, `userJwt`, `client`, `language`, `insecure` |

Mỗi profile còn có `ideId` và `terminalId` (UUID ổn định, dùng cho debugger). Một profile cũng có thể gắn thêm `abaplintConfig` (qua `adt auth profile set-lint-config`) để `adt lint`/`adt context` dùng.

> ⚠️ Secret chỉ **obfuscate bằng base64**, không phải mã hóa — không log hoặc in ra stdout.

### Pull config (dùng chung cho `adt object pull` và `adt context build`)

- **User-level:** `~/.adt-cli/pull-config.json` (tự bootstrap từ default khi pull lần đầu)
- **Project-level:** `<cwd>/.adt-cli/pull-config.json` (override toàn phần, không merge)

```json
{
  "version": 1,
  "pullTypes": ["CLAS/OC", "INTF/OI", "TABL/DT", "..."],
  "namespacePrefixes": ["Z", "Y", "/RB"]
}
```

- **Thứ tự ưu tiên** (thấp → cao): built-in default → user config → project config → CLI flags (`--include-only`/`--skip-types` cho `pullTypes`; `--namespace-prefixes` cho namespace).
- **`namespacePrefixes`**: một node chỉ được pull nếu `name` bắt đầu (không phân biệt hoa/thường) bằng 1 trong các tiền tố này. Mặc định `["Z","Y","/RB"]`. Mảng rỗng `[]` = **chặn tất cả** (an toàn theo mặc định) — tránh việc các include sinh tự động bởi SE54 (`LSVIMTOP`, `LSVIMF01`...) bị kéo theo và làm treo quá trình fetch.
- Xem cấu hình hiệu lực mà **không** gọi SAP: `adt object pull --package ZPK_X --print-config`.

---

## 8. Exit codes

| Code | Ý nghĩa |
|---|---|
| `0` | Thành công |
| `1` | Lỗi chung (HTTP non-2xx, lỗi parse, thiếu profile, activate thất bại, `atc check`/`adt lint` có **error**, `context build` có package lỗi) |
| `2` | Xác thực/verify thất bại (`auth login test`, `auth destinations test`), `atc check`/`adt lint` chỉ có **warning**, `context inspect` vượt token budget |
| `130` | Ctrl-C khi đang nhập input ẩn (password) |

> Với `adt atc check` và `adt lint *`: `1` = có error, `2` = chỉ có warning.

---

## 9. Quick start / Recipes tổng hợp

```bash
# 1) Lưu credential và xác minh
adt auth login basic --name dev \
  --url https://abap:44300 --user DEVELOPER --password '****'

# 2) Kiểm tra kết nối
adt system discovery

# 3) Đọc source code
adt object source programs/programs/zroman > zroman.abap

# 4) Truy vấn dữ liệu
adt data sql 'SELECT CARRIER_ID, CUSTOMER_ID FROM /DMO/BOOKING WHERE BOOKING_ID = 0005' --rows 5

# 5) Tạo + push + activate trong một lệnh
adt object create program ZHELLO --package $YMU_PKG \
  --description "Hello from adt-cli" \
  --source-file ./zhello.abap --activate

# 6) Mirror cả package về local để phân tích offline
adt object pull --package $YMU_PKG

# 7) Lint toàn bộ package đã pull (hoặc lint trực tiếp qua ADT) và tự sửa lỗi auto-fixable
adt lint package $YMU_PKG --fix

# 8) Lấy skeleton + metrics để đưa vào LLM context
adt lint skeleton --package $YMU_PKG
adt lint metrics --package $YMU_PKG --top 10

# 9) Build bộ context LLM-ready cho cả package
adt context build --package $YMU_PKG --out ./adt-context --with-docs --with-where-used
adt context inspect ./adt-context/$YMU_PKG --target-model claude-opus-4-7

# 10) Chạy ATC end-to-end
adt atc check oo/classes/zcl_foo --variant DEFAULT
```
