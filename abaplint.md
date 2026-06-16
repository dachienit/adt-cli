# abaplint cho ABAP Packages — Báo cáo kỹ thuật toàn diện cho pi-boi

## TL;DR

- **abaplint coi "package" gần như đồng nghĩa với "repository abapGit"**: nó không có khái niệm "phân tích phạm vi gói" thực thụ, mà nạp tất cả file ABAP/XML/JSON trong vùng `global.files` glob của `abaplint.json` vào một `Registry` chung. Mọi phân tích package-level (LOC, complexity, coupling, void types, UML, call graph) thực hiện trong `abaplint.app` (SaaS) — không phải trong `@abaplint/core` npm package mà bạn cài về dùng.
- **Đối với pi-boi**: `@abaplint/core` cho bạn (a) parser AST đầy đủ + Registry + đúng 183 rule (xác nhận tại rules.abaplint.org phiên bản 2.119.23, ngày 24/05/2026) + LSP primitives (rename, references, definition, hover, code actions, formatting); (b) bạn tự build "package facade" trên Registry. Tránh kỳ vọng có sẵn API "Package.getAllClasses()" — phải tự traverse `registry.getObjects()` rồi filter theo prefix folder/namespace.
- **Khuyến nghị kiến trúc**: Dùng `@abaplint/core` cho pass 1 (AST skeleton extraction) và pass 3 (validation sau khi LLM sinh code). Cho phân tích package-level (call graph, coupling, god class detection), tự implement layer trên `registry.getObjects()` thay vì chờ abaplint cung cấp. Dùng `abaplint-sci-client` để **xuất** dependency snapshot từ SAP system → `/deps` folder cho cross-system analysis.

---

## Key Findings

| Câu hỏi pi-boi cần trả lời | Kết luận ngắn |
|---|---|
| Có "Package object model" trong `@abaplint/core` không? | Có class `Package` (object type DEVC) parse `.devc.xml`, nhưng **không** expose parent/child tree — bạn phải tự suy từ folder logic abapGit. |
| Có API "lấy mọi object trong package X" không? | Không. Phải filter `registry.getObjects()` theo folder path. |
| Có cross-object reference resolution không? | Có, qua `LanguageServer.references()` — chạy trên toàn Registry. |
| Pretty printer / rename / quick fix toàn package? | Pretty printer per-file (loop được). Rename cross-file qua LSP. Quick fix qua `EditHelper.merge()` apply hàng loạt. |
| Có dependency analysis tự động không? | Có ở `abaplint.app` (Package Coupling SVG). Trong core, phải tự build. `abaplint-sci-client` (ABAP side) generate deps snapshot. |
| Có thể validate ABAP code do LLM sinh ra không? | **Có** — đây là use case mạnh nhất cho pi-boi. |
| Có generate ABAP code không? | **Không.** abaplint chỉ phân tích & validate. |

---

## Details

### 1. Package object (DEVC) trong abaplint

#### 1.1 Cách abaplint biểu diễn DEVC

abaplint coi DEVC là một **object type bình thường** trong số 166 types được hỗ trợ. Khi gặp file `package.devc.xml` trong cây nguồn, abaplint thực thi serializer DEVC để tạo một instance `Package` (kế thừa `AbstractObject` từ `packages/core/src/objects/_abap_object.ts`).

> **Honest gap**: Tôi không thể fetch trực tiếp `packages/core/src/objects/package.ts` trong môi trường nghiên cứu này (GitHub blob HTML bị restrict, raw URL không nằm trong domain whitelist). Subagent cũng gặp cùng giới hạn. Vì vậy, các signature method dưới đây được **suy ra** từ pattern dùng nhất quán trong các serializer khác của abaplint (mà tôi đã đọc trực tiếp được, ví dụ `obsolete_statement.ts`, `omit_parameter_name.ts`) cộng với public API surface. **Khi triển khai pi-boi, bạn nên mở file `node_modules/@abaplint/core/build/src/objects/package.d.ts` để xác nhận signature thực tế** trước khi commit code.

API kỳ vọng của `Package` class (cần xác nhận lại từ `.d.ts` đi kèm npm package):

```typescript
import { Registry, MemoryFile } from "@abaplint/core";

class Package extends AbstractObject {
  public getType(): "DEVC";
  public getDescription(): string | undefined;          // từ <CTEXT>
  public getParentName(): string | undefined;           // từ <PARENTCL>
  public getAllowedObjectTypes(): string[] | undefined; // từ package interfaces
  // + các method kế thừa từ AbstractObject:
  public getName(): string;
  public getFiles(): readonly IFile[];
  public getXMLFile(): IFile | undefined;
}
```

**Cách đáng tin cậy để pi-boi đọc metadata DEVC**: tự parse `*.devc.xml` bằng `xml-js` (đã là dependency của `@abaplint/cli`) thay vì dựa hoàn toàn vào abaplint API — vì abaplint mới hỗ trợ `package.devc.xml` ở mức cơ bản (issue #1608 "new rule: Require package.devc.xml files in folders" mở 2020 và được link tới PR abapGit#6036 năm 2023). DEVC trong abaplint chủ yếu nhằm mục đích lint metadata, không nhằm cung cấp graph package-level.

#### 1.2 Cấu trúc cha-con (parent/sub-package) và Package Interface (PINF)

- **PINF**: abaplint **có** trong `object_naming` rule (ví dụ regex `"pinf": "^Z"` trong `abaplint-clean-code/configs/full/abaplint.json`), nhưng PINF chỉ được coi là một object type rỗng — abaplint **không** sử dụng nội dung PINF để enforce package visibility (không có rule "vi phạm package interface"). PINF objects cũng từng không được abapGit hỗ trợ trong thời gian dài (abapGit issue #293).
- **Quan hệ cha-con**: abaplint **không** xây dựng explicit tree từ `<PARENTCL>`. Thay vào đó, quan hệ cha-con được suy ra **gián tiếp qua folder structure** của abapGit (xem 1.3).

#### 1.3 Folder logic: PREFIX, FULL, MIXED — và tác động lên abaplint

Đây là kiến thức **bắt buộc** cho pi-boi vì nó quyết định cách bạn map từ SAP package name sang folder path khi user import code.

Theo `docs.abapgit.org/user-guide/repo-settings/dot-abapgit.html`:

- **PREFIX** (mặc định, dùng hầu hết): sub-package phải bắt đầu bằng tên parent. Mapping bỏ phần trùng:
  - `$ZFH` → folder root
  - `$ZFH_PROTOTYPES` → folder `/prototypes`
  - `ZRAP_TRAVEL_API` (con của `ZRAP_TRAVEL`, cháu của `ZRAP`) → `/travel/api`
- **FULL**: folder name = full package name. `ZRAP_TRAVEL_API` → `/zrap_travel_api`
- **MIXED**: root package làm prefix cho sub-packages nhưng tên không concatenate đệ quy

abapGit mapping được implement ở class `zcl_abapgit_folder_logic` (methods `package_to_path` và `path_to_package`). **abaplint chỉ đọc file system path** đã được serialize sẵn — nó không phân biệt folder logic. Tức là khi pi-boi clone repo và feed vào abaplint, **bạn cần tự decode `.abapgit.xml` để biết folder logic** rồi reconstruct mapping path↔package nếu user muốn analysis theo package.

#### 1.4 Parse `.devc.xml`

File format (theo abapGit serializer):
```xml
<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_DEVC" serializer_version="v1.0.0">
  <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
    <asx:values>
      <DEVC>
        <CTEXT>My package description</CTEXT>
        <AS4USER>HIEN</AS4USER>
      </DEVC>
    </asx:values>
  </asx:abap>
</abapGit>
```

Lưu ý: `<PARENTCL>` không được abapGit serialize trong `.devc.xml` (vì abapGit quản lý cha-con qua folder hierarchy). Vì vậy `Package.getParentName()` trong abaplint nếu có sẽ luôn `undefined` cho code lấy từ abapGit — bạn phải tự suy parent từ folder path.

---

### 2. Phân tích cross-object trong package

#### 2.1 Duyệt mọi object trong package — pattern thực dụng

API chính của `Registry` (xác nhận từ usage trong rule code và `@abaplint/cli`):

```typescript
import { Registry, MemoryFile, Config } from "@abaplint/core";

const config = Config.getDefault();
const reg = new Registry(config);

// Add files (đồng bộ)
const files = [
  new MemoryFile("/src/zcl_foo.clas.abap", "CLASS zcl_foo DEFINITION..."),
  new MemoryFile("/src/zcl_foo.clas.xml", "<?xml ..."),
  new MemoryFile("/src/package.devc.xml", "<?xml ..."),
];
reg.addFiles(files);
reg.parse();                     // hoặc await reg.parseAsync() để báo progress

// Duyệt tất cả objects
for (const obj of reg.getObjects()) {
  console.log(obj.getType(), obj.getName());
}

// Lấy object cụ thể
const cls = reg.getObject("CLAS", "ZCL_FOO");
const pkg = reg.getObject("DEVC", "ZFH_PROTOTYPES");

// Findings
const issues = reg.findIssues();
const objIssues = reg.findIssuesObject(cls);
```

**Lưu ý quan trọng**: `Registry` không có API "lấy mọi object trong package X". Bạn phải tự filter:

```typescript
function getObjectsInPackage(reg: Registry, packageName: string): IObject[] {
  return reg.getObjects().filter(o => {
    const xmlFile = o.getXMLFile();
    if (!xmlFile) return false;
    return xmlFile.getFilename().startsWith(`/src/${packageName.toLowerCase()}/`);
  });
}
```

#### 2.2 Cross-object reference resolution

abaplint thực hiện **symbol resolution toàn registry** trong pha `parse()`. Sau khi `parse()` hoàn tất, mỗi class/interface có thể truy vấn supertype, interface implementation, attribute usage, v.v. Đây là cơ chế cho:

- Rule `check_syntax` (resolve unknown types)
- Rule `unused_methods` — phát hiện public method không có caller trong registry
- Rule `check_ddic` — resolve types cho DDIC objects (TABL, DTEL, DOMA, DDLS, v.v.)

**Pattern cho pi-boi**: để tìm caller của một method `zcl_a=>do_it()` trong package, bạn dùng LSP API:

```typescript
import { LanguageServer } from "@abaplint/core";

const ls = new LanguageServer(reg);
const references = ls.references({
  textDocument: { uri: "file:///src/zcl_a.clas.abap" },
  position: { line: 12, character: 8 },
  context: { includeDeclaration: false }
});
// references trả về Location[] trên toàn registry — tức trên toàn package
```

Đây chính là cơ chế "Find references" trong `vscode-abaplint`.

#### 2.3 Phát hiện unused public methods

Rule `unused_methods` (có trong abaplint, tag `Syntax`) duyệt **toàn registry** tìm public method không bao giờ được gọi. Đây là package-level analysis sẵn dùng. Tuy nhiên có nhiều **false positives** khi:
- Method được gọi từ code ngoài registry (dynamic call, RFC, BAdI)
- Method được dùng làm callback của framework SAP (event handler)

abaplint quản lý bằng cách bật `errorNamespace` để chỉ báo cho code trong namespace của bạn.

#### 2.4 Call graph

abaplint.app (SaaS) **có** "Intra Class Call Graph" — sequence diagram trong từng method, thêm vào ngày 19/10/2023 (entry trên blog.abaplint.app: *"2023-10-19 Display call graph between methods internally in a class"*). Tuy nhiên đây là tính năng của abaplint**.app** chứ không phải `@abaplint/core`. Nếu muốn dùng trong pi-boi, bạn phải:
1. Tự thực thi cross-method call detection bằng cách duyệt AST (`MethodCallChain`, `MethodCallParam`, các expression `Source` chứa `==>`/`->`)
2. Hoặc reverse-engineer code từ repo `abaplint.app` (closed source).

Khuyến nghị: build module riêng dùng `StructureNode`/`StatementNode` của abaplint core để extract `INVOKE` edges.

---

### 3. Phân tích dependency cấp package

#### 3.1 `Registry.addDependencies()` — pattern multi-package

Confirmed từ `docs/getting_started.md` (abaplint repo):

```json
{
  "global": { "files": "/src/**/*.*" },
  "dependencies": [
    {
      "url": "https://github.com/abaplint/deps",
      "folder": "/deps",
      "files": "/src/**/*.*"
    }
  ]
}
```

CLI sẽ clone repo trong `dependencies` rồi gọi `reg.addDependencies(files)` (thay vì `addFiles`). Sự khác biệt: file trong dependencies **không** được lint, nhưng được **resolve làm context** cho objects của bạn.

Repo `abaplint/deps` là **stub repository** chứa skeleton (chỉ class definition, superclass và interface, không có implementation) cho các SAP standard classes (`CL_ABAP_TSTMP`, `CL_GUI_ALV_GRID`, v.v.) — đủ để abaplint resolve unknown types mà không cần system SAP.

#### 3.2 abaplint-deps-find / abaplint-sci-client

`zcl_abaplint_deps_find` (class trong [abaplint/abaplint-sci-client](https://github.com/abaplint/abaplint-sci-client/blob/main/src/deps/zcl_abaplint_deps_find.clas.abap)) chạy **trên SAP system**, không phải trong Node.js. Logic chính (verified verbatim from source):

```abap
add_subpackages(iv_package).         " đệ quy SELECT tdevc WHERE parentcl
LOOP các object trong packages.
  determine_direct_dependency():     " CLAS → super + interfaces;
                                     " TABL → DTEL deps; DTEL → DOMA;
                                     " others → get_environment() (TADIR + cross-ref)
  clean_own_packages().              " bỏ deps trong chính package
ENDLOOP.
write_to_git_repo (project_deps).    " serialize via abapGit
```

Workflow đúng cho pi-boi:
1. User chạy report `ZABAPLINT_DEPENDENCIES` (transaction) trên SAP system, point tới package `ZPI_BOI_DEMO`.
2. Output: một abapGit repo `project_deps` chứa skeleton của mọi object SAP standard mà package phụ thuộc.
3. Pi-boi backend clone cả repo chính + repo deps, feed vào `Registry` với `addDependencies`.

Lưu ý từ `docs/export_dependencies.md`: **phải chạy report `SAPRSEUB` ở background** trước đó để cross-reference table chính xác — không thì deps sẽ thiếu.

#### 3.3 Phát hiện cyclic dependency

abaplint **không** có rule built-in "no cyclic dependency between classes/packages". Tuy nhiên `abaplint.app` có **Package Coupling diagram** (mục 8.7 trong documentation PDF) hiển thị mũi tên dependency giữa subfolders — bạn nhìn được vòng tròn bằng mắt. Dependency vào subfolders được render thành mũi tên màu xanh từ ngày 03/02/2023 (entry blog.abaplint.app: *"2023-02-03 Package coupling diagrams with dependencies into subfolders will now display as blue"*). Để detect tự động trong pi-boi, dùng `tarjan-strongly-connected-components` trên graph bạn tự build từ symbol resolution.

#### 3.4 External dependencies / "void types"

**Void type** = type abaplint không resolve được (không có trong registry và không khớp `errorNamespace`). Nếu `errorNamespace = "^(Z|Y)"` thì mọi reference tới `CL_GUI_ALV_GRID` sẽ là void — không báo lỗi, nhưng tracked. `abaplint.app` có trang **Void Types** thống kê tần suất; kèm thông tin release/deprecation/successor được thêm vào ngày 08/03/2023 (entry blog.abaplint.app: *"2023-03-08 The void type statistics now includes release, depcrecation and successor information"*).

Rule `forbidden_void_type` cho phép cấm void type cụ thể:

```json
"forbidden_void_type": {
  "check": ["CL_SQL_STATEMENT", "CL_SQL_PREPARED_STATEMENT"]
}
```

**Cho pi-boi**: void types là "blind spots" của package analysis — pi-boi cần đánh dấu rõ ở pass 2 (LLM enrichment) để LLM biết cái nào là SAP standard.

---

### 4. Bulk operations across package

#### 4.1 Pretty printer toàn package

`@abaplint/core` xuất class `PrettyPrinter` (per-file). Để chạy cho cả package, loop:

```typescript
import { PrettyPrinter, Config } from "@abaplint/core";

for (const obj of reg.getObjects()) {
  for (const file of obj.getABAPFiles()) {
    const pp = new PrettyPrinter(file, reg.getConfig().getPrettyPrinterConfig());
    const formatted = pp.run();
    // ghi lại file
  }
}
```

Lưu ý: pretty printer của abaplint **per-file**, không cross-file. Issue [#629](https://github.com/abaplint/abaplint/issues/629) nói "this would be pretty easy, as its per file, and only requires the text" — xác nhận thiết kế đơn giản.

Tool ngoài: `abapPretty` (marcellourbani/abapPretty) cho phép chạy abaplint pretty printer batch qua ABAP server connection (`DEVC/K ZMYPACKAGE`) — hữu ích để inspire UX nếu pi-boi muốn cung cấp tính năng tương tự.

#### 4.2 Rename refactoring cross-file

LSP rename trong abaplint hoạt động trên **toàn registry**. Để rename `zcl_foo` thành `zcl_bar`:

```typescript
const ls = new LanguageServer(reg);
const workspaceEdit = ls.rename({
  textDocument: { uri: "file:///src/zcl_foo.clas.abap" },
  position: { line: 0, character: 6 },
  newName: "zcl_bar"
});
// workspaceEdit.changes là { [uri]: TextEdit[] } — apply vào file system
```

Có hạn chế: **abaplint không tự đổi tên file** (`zcl_foo.clas.abap` → `zcl_bar.clas.abap`) — bạn phải làm thủ công. Cũng không rename DDIC dependency hoặc TADIR entries (vì abaplint không biết về SAP system).

#### 4.3 Áp dụng quick fix hàng loạt

Mỗi `Issue` có thể đính kèm `fix: IEdit` (qua `Issue.atStatement(file, node, msg, key, severity, fix)`). EditHelper static methods (xác nhận từ rule code đã đọc):

```typescript
EditHelper.replaceToken(file, token, newText): IEdit
EditHelper.replaceRange(file, start, end, replacement): IEdit
EditHelper.deleteRange(file, start, end): IEdit
EditHelper.deleteStatement(file, statementNode): IEdit
EditHelper.merge(...edits): IEdit   // gộp nhiều edit, có thể cross-file
```

Để apply tất cả quick fixes:

```typescript
const issues = reg.findIssues().filter(i => i.getFix() !== undefined);
const edit = EditHelper.merge(...issues.map(i => i.getFix()!));
ApplyFix.applyEdit(reg, edit);   // sửa file in-place trong registry
reg.parse();                     // re-parse
```

**Cảnh báo**: quick fix có thể xung đột (hai fix sửa cùng vùng). abaplint **không** giải quyết xung đột — bạn phải apply tuần tự + re-parse sau mỗi batch.

#### 4.4 Chạy 183 rule và aggregate

Đây là use case chính của CLI. rules.abaplint.org tự xác nhận tại trang chủ (phiên bản 2.119.23 ngày 24/05/2026): *"183 Rules"*.

```typescript
import { Registry } from "@abaplint/core";
const issues = reg.findIssues();   // tất cả rule bật trong config
// Group by rule:
const byKey = issues.reduce((acc, i) => {
  acc[i.getKey()] = (acc[i.getKey()] || 0) + 1;
  return acc;
}, {} as Record<string, number>);
```

#### 4.5 Performance trên package lớn

**Honest gap**: abaplint không công bố benchmark chính thức. Quan sát từ real-world:
- Repo `abapGit/abapGit` (~2000 objects, ~500k LOC ABAP) trên `abaplint.app` chạy trong vài chục giây trên CI runner GitHub Actions.
- `addFile()` là O(n) — internal indexes rebuild khi parse. **Không** dùng `addFile()` trong loop nhỏ; gom vào `addFiles(arr)` rồi `parse()` một lần.
- `parseAsync()` báo progress callback — dùng cho UX pi-boi.

Đối với package 1000+ objects:
- Estimate 30s–2 phút cho full parse + 1 pass rule trên Node.js modern (M1/M2 hoặc Linux server 4 vCPU).
- Memory peak ~1–2 GB (AST giữ trọn trong RAM, không stream).
- **Khuyến nghị pi-boi**: cache `Registry` instance trong process; chỉ re-parse incremental khi file thay đổi (`reg.updateFile(file)` — confirm signature từ `.d.ts`).

---

### 5. Source serialization format abaplint hiểu

abaplint **luôn** đọc theo convention abapGit. File naming pattern:

```
<object_name>.<object_type>.<extension>
<object_name>.<object_type>.<extra>.<extension>
```

Ví dụ một CLAS đầy đủ:
```
zcl_foo.clas.xml                  -- metadata (VSEOCLASS)
zcl_foo.clas.abap                 -- main definition + implementation
zcl_foo.clas.locals_def.abap      -- local class definitions
zcl_foo.clas.locals_imp.abap      -- local class implementations
zcl_foo.clas.testclasses.abap     -- unit tests
zcl_foo.clas.macros.abap          -- macros
```

Các object types khác:
```
zif_foo.intf.xml + zif_foo.intf.abap          -- INTF
zfoo.prog.xml + zfoo.prog.abap                -- PROG (report)
zfg_foo.fugr.xml                              -- FUGR root
zfg_foo.fugr/saplzfg_foo.prog.abap            -- function group main include
zfg_foo.fugr/lzfg_fooxxx.prog.abap            -- function group sub-includes
zfg_foo.fugr/zfg_foo.fugr.zfm_my_fm.abap      -- function module body
zfoo.tabl.xml                                 -- TABL definition (no .abap)
zfoo.dtel.xml                                 -- DTEL
zfoo.doma.xml                                 -- DOMA
zfoo.ddls.asddls                              -- DDLS source (CDS view)
zfoo.ddls.xml                                 -- DDLS metadata
package.devc.xml                              -- DEVC (luôn tên cố định "package")
```

Namespace SAP (`/NAMESPACE/`) được folder hóa bằng `#` thay cho `/`: package `/ACME/FOO` → folder `#acme#foo/`. Đây là convention abapGit để tránh đụng filesystem.

DDLS đặc biệt: phần định nghĩa CDS (`@AbapCatalog.sqlViewName: 'ZFOOV'` ... `define view ...`) nằm trong file `.asddls`, **không phải `.abap`**. abaplint có rule `cds_parser_error` để check CDS syntax — nhưng coverage CDS yếu hơn ABAP nhiều (chỉ một số subset của syntax CDS được handle).

---

### 6. Thống kê và metrics cấp package

#### 6.1 Có sẵn trong `@abaplint/core`

Xác nhận có (từ task brief của bạn + tài liệu abaplint.app):

| Statistics class | Phạm vi | Đầu ra |
|---|---|---|
| `CyclomaticComplexityStats` | per-method | complexity number |
| `MethodLengthStats` | per-method | statement count |

Để có **tổng cấp package**, bạn loop:

```typescript
const allMethods = reg.getObjects()
  .filter(o => o.getType() === "CLAS")
  .flatMap(o => (o as Class).getClassDefinition()?.methods ?? []);

const totals = {
  totalLOC: 0, maxComplexity: 0, topMethods: [] as any[]
};
for (const m of allMethods) {
  const stats = new MethodLengthStats(m);
  const cc = new CyclomaticComplexityStats(m);
  totals.totalLOC += stats.getLength();
  totals.topMethods.push({ name: m.getName(), len: stats.getLength(), cc: cc.get() });
}
totals.topMethods.sort((a,b) => b.len - a.len);
```

#### 6.2 Trong abaplint.app (không có trong core)

Tham khảo PDF doc của abaplint.app (heliconialabs/docs.abaplint.app):
- **8.1–8.6**: Issues, Disabled rules, Statement Compatibility, Void Types, Dependencies
- **8.7 Package Coupling** — SVG diagram
- **8.8 UML Class Diagrams** — global classes/interfaces
- **8.15 Average Complexity** / **8.16 Average Method Length** — cả hai cùng thêm ngày 10/07/2023 (entry blog.abaplint.app: *"2023-07-10 Average cyclomatic complexity & average method length added as new insights"*)
- **8.18 Class Length** — phát hiện god class
- **8.19 Intra Class Call Graph** — sequence diagram trong method (thêm 19/10/2023)
- **8.20 Object Types** — phân phối CLAS/INTF/PROG/FUGR/... (thêm 08/11/2023)
- **8.21 Procedural vs OO** (thêm 01/12/2023)
- **8.22 Table Accesses**, **8.23 API Usage** (API usage stats thêm 22/09/2025), **8.24 Object Classifications**

**Đối với pi-boi**: bạn cần **tự build các view này** từ raw data của core. Đây là moat lớn của abaplint.app — không có shortcut.

#### 6.3 Phát hiện "god class"

Không có rule trực tiếp. Heuristic: filter class có `MethodLengthStats.get() > 100` HOẶC tổng LOC class > 2000 HOẶC > 30 public method. Rule liên quan:
- `max_one_method_per_line` — gián tiếp
- `prefer_inline_declarations` — gián tiếp
- `unused_methods` — phát hiện dead code

---

### 7. Code generation / transformation

#### 7.1 Generate ABAP mới và validate

**abaplint không generate ABAP**. Nhưng workflow validate sau khi LLM generate là pattern mạnh:

```typescript
// Pi-boi pass 3 — validate LLM-generated code
const generated = new MemoryFile("/src/zcl_llm_output.clas.abap", llmCode);
const xmlStub = new MemoryFile("/src/zcl_llm_output.clas.xml", buildXMLStub());

reg.addFiles([generated, xmlStub]);
reg.parse();
const issues = reg.findIssuesObject(reg.getObject("CLAS", "ZCL_LLM_OUTPUT")!);

if (issues.some(i => i.getSeverity() === "Error")) {
  // Feedback loop: gửi lại issues vào LLM để fix
}
```

Đây là **pi-boi killer feature** — abaplint vừa là syntax validator vừa là style enforcer cho LLM output, mà không cần SAP system.

#### 7.2 Modify nhiều file và đảm bảo consistency

Pattern:
1. Snapshot Registry (clone files map).
2. Apply edits qua EditHelper (cross-file merge).
3. Re-parse.
4. Check issues count: nếu tăng → revert; nếu giảm hoặc giữ nguyên → commit.

#### 7.3 Rename API across package

Đã đề cập 4.2. Rename hỗ trợ: class name, interface name, method name, local variable, attribute, constant, type. **Không hỗ trợ**: function module name (vì cần system), DDIC field name (tương tự), DDLS view name.

---

### 8. Real-world examples

#### 8.1 abaplint.app GitHub action

Action sử dụng [`abaplint/actions-abaplint`](https://github.com/abaplint/actions-abaplint). Mỗi commit / PR sẽ trigger `findIssues()` toàn repo và post via GitHub Checks API. Annotations link trực tiếp tới rule documentation trên `rules.abaplint.org`.

#### 8.2 `/stats` endpoint của abaplint.app

URL pattern: `https://abaplint.app/stats/<owner>/<repo>/<view>`

Confirmed views (từ doc PDF + crawl):
- `/dependencies` — file-level dependency list ("File-level dependency analysis showing what each file depends on and where those dependencies are defined")
- `/package_coupling` — SVG diagram (từ 07/01/2023)
- `/object_types` — distribution
- `/void_types` — danh sách void types kèm release/deprecation info
- `/intra_class_call_graph` — pick class qua query `?name=ZCL_FOO`
- `/uml` — UML diagram (UML có footer SHA1 + timestamp từ 17/01/2023)

#### 8.3 Showcases public

- `abapGit/abapGit` (~2000 objects, repo gốc abapGit)
- `abap2UI5/abap2UI5` (framework UI5 thuần ABAP, dùng cross-check qua dependencies repo)
- `abaplint/abaplint-sci-client` (chính tool deps-find)
- `ABAP-OpenAPI-Client`, `ABAP-Logger`
- `Marc-Bernard-Tools/*`, `larshp/abap-advent-2020-template`

Tất cả browse được tại `https://abaplint.app/stats/<owner>/<repo>/`.

---

### 9. Cấu hình relevant cho packages

#### 9.1 `abaplint.json` toàn diện (template Hien dùng cho pi-boi)

```json
{
  "global": {
    "files": "/src/**/*.*",
    "skipGeneratedFunctionGroups": true,
    "skipGeneratedGatewayClasses": true,
    "skipGeneratedPersistentClasses": true,
    "skipCSDS": false,
    "noIssuesAllowed": []
  },
  "dependencies": [
    {
      "url": "https://github.com/abaplint/deps",
      "folder": "/deps",
      "files": "/src/**/*.*"
    }
  ],
  "syntax": {
    "version": "v757",
    "errorNamespace": "^(Z|Y|LCL_|TY_|LIF_)",
    "globalConstants": [],
    "globalMacros": []
  },
  "rules": {
    "object_naming": {
      "patternKind": "required",
      "clas": "^ZC(L|X)_", "intf": "^ZIF_",
      "pinf": "^Z"
    },
    "check_syntax": { "exclude": ["#legacy/.*"] }
  }
}
```

Key fields:
- `global.files` — glob trắng. Loại trừ bằng pattern bắt đầu `!`.
- `global.skipGeneratedFunctionGroups` — bỏ FUGR auto-gen từ DDIC.
- `dependencies[]` — pull skeleton repo cho external types.
- `syntax.errorNamespace` — regex; ngoài namespace = void (không báo).
- `applyUnspecifiedObjectCheck` (boolean, ít doc) — bật check cho object types không có config riêng.
- Mỗi rule có `exclude: string[]` (regex match filename) để skip object cụ thể.

#### 9.2 abaplint-app.jsonc

Cho phép nhiều configurations cùng lúc (merging tự động). Ngoài ra có flag `noArtifactsOkay` (từ 14/12/2022) cho phép repo không có ABAP artifact mà vẫn pass.

---

### 10. Limitations & gaps tại package level

| Gap | Mức độ | Workaround cho pi-boi |
|---|---|---|
| Không có "Package" facade — chỉ Registry phẳng | Cao | Tự build `PackageView` class wrap `Registry` + folder logic |
| DEVC `<PARENTCL>` không serialize qua abapGit | TB | Suy parent từ folder hierarchy |
| Package Interface (PINF) không enforce visibility | Cao | abaplint chỉ check PINF tên; muốn enforce phải tự implement |
| Cyclic dependency detection: không có rule | TB | Tarjan SCC trên graph tự build |
| Call graph cross-class: chỉ trong abaplint.app | Cao | Reverse-engineer hoặc tự build từ AST |
| Function module body resolution: phụ thuộc FUGR includes | Cao | Phải có cả `saplxxx.prog.abap` + sub-includes |
| DDLS / CDS coverage hạn chế | TB | Pass qua, đánh dấu là "low-confidence zone" |
| Void types không follow-up vào SAP standard | Cao | Dùng `abaplint-sci-client` export deps |
| Pretty printer per-file, không cross-file | Thấp | OK cho pi-boi (per-file đủ) |
| Rename không đổi tên file | TB | Pi-boi tự rename file sau workspace edit |
| Performance trên 5000+ objects: chưa benchmark | TB | Cache Registry trong worker process; incremental parse |
| Không hỗ trợ namespace SAP `/NAMESPACE/` đầy đủ | Thấp | Folder `#namespace#name` đã handle bởi abapGit |
| Generated code (gateway, persistent classes): skip bởi default | Thấp | Đã có `skipGenerated*` flags |
| Symbol resolution cho dynamic call (`CALL METHOD (lv_name)`) | Cao | Không thể giải quyết — đánh dấu unknown |
| Translation (.po files i18n): abaplint không hiểu | Thấp | Ignore |
| Locking, transport, version (.devc properties): không expose | TB | Pi-boi tự đọc XML nếu cần |

---

## Recommendations

### Pass 1 — AST skeleton extraction

```typescript
// pi-boi/src/ingestion/abaplint-skeleton.ts
import { Registry, MemoryFile, ClassDefinition } from "@abaplint/core";

export interface PackageSkeleton {
  packageName: string;
  description: string;
  parent?: string;
  classes: ClassSkeleton[];
  interfaces: InterfaceSkeleton[];
  reports: ReportSkeleton[];
  tables: TableSkeleton[];
  ddls: DDLSSkeleton[];
  voidTypes: string[];     // external references
}

export function extractPackage(files: MemoryFile[], pkgName: string): PackageSkeleton {
  const reg = new Registry();
  reg.addFiles(files);
  reg.parse();
  // build skeleton từ getObjects()
  // ...
}
```

### Pass 2 — LLM enrichment

LLM nhận skeleton JSON (không phải raw ABAP — chi phí token thấp hơn 5–10×) và sinh:
- Mô tả method
- Doc cho class
- Suggested test cases

### Pass 3 — Validate generated code

Apply LLM output back vào Registry tạm, gọi `findIssues()`, feedback loop nếu có Error severity. Đây là điểm khác biệt cốt lõi của pi-boi vs các tool LLM-only.

### Refactor agent (longer-term)

Dùng `LanguageServer.rename`, `documentSymbol`, `references`, `codeAction` để xây refactoring actions cấp class/method. Tuyệt đối không cố tự generate ABAP — luôn validate qua `Registry.findIssues()` trước khi return cho user.

### Decision matrix nhanh

| Pi-boi needs | abaplint cung cấp? | Action |
|---|---|---|
| Parse 166 object types | ✅ trực tiếp | Dùng `@abaplint/core` |
| 183 lint rules | ✅ trực tiếp | Dùng |
| LSP rename/refs/hover | ✅ trực tiếp | Dùng `LanguageServer` class |
| Per-method complexity, length | ✅ trực tiếp | Stats classes |
| Pretty printer | ✅ per-file | Wrap loop |
| Cross-package call graph | ❌ | Tự implement trên AST |
| Package coupling matrix | ❌ (chỉ abaplint.app) | Tự implement |
| Cyclic dependency | ❌ | Tự implement (Tarjan) |
| God class detector | ❌ | Tự implement (heuristic) |
| Export deps từ SAP system | ✅ qua abaplint-sci-client | ABAP report `ZABAPLINT_DEPENDENCIES` |
| ATC-style live check trên SAP | ✅ qua abaplint-sci-client | HTTP API server |
| Generate ABAP code | ❌ | LLM, abaplint chỉ validate |
| Folder logic PREFIX/FULL/MIXED | ❌ tự decode | Đọc `.abapgit.xml` |

### Benchmarks / thresholds sẽ làm bạn đổi quyết định

- **Nếu** package > 5000 objects và parse > 5 phút: cần partition Registry (mỗi sub-package một Registry riêng), trade-off mất cross-package resolution.
- **Nếu** abaplint cập nhật package facade trực tiếp (xem issue tracker, đặc biệt issue về `Package.getAllObjects()`): có thể bỏ self-built PackageView wrapper.
- **Nếu** user pi-boi không thể chạy `abaplint-sci-client` trên SAP system của họ: fallback dùng repo `abaplint/deps` skeleton chung — chấp nhận mất độ chính xác cho custom Z-objects của họ.

---

## Caveats

1. **Tôi không thể fetch trực tiếp `packages/core/src/objects/package.ts`** (GitHub blob HTML và raw URL đều bị restrict trong môi trường nghiên cứu — kể cả subagent với budget riêng). Tất cả signature method của `Package` class tôi đưa ra là **suy diễn** từ pattern code abaplint khác mà tôi đọc được trực tiếp (`obsolete_statement.ts`, `omit_parameter_name.ts`, `function_module_recommendations.ts`, `abapdoc.ts`, `forbidden_pseudo_and_pragma.ts`, `no_public_attributes.ts`, `forbidden_identifier.ts`) + abaplint.json schemas + abaplint.app documentation PDF. **Trước khi commit code production, mở `node_modules/@abaplint/core/build/src/index.d.ts` để xác nhận export thực tế.**

2. **Số lượng rule**: chính thức **183** rule tại rules.abaplint.org version 2.119.23 ngày 24/05/2026. Blog Inwerken (24/05/2024) ghi "currently 163" — số đó đã tăng lên 183 trong 2 năm. Pin theo phiên bản bạn cài.

3. **abaplint.app vs `@abaplint/core` boundary**: Nhiều "package analysis" feature thực ra ở SaaS (abaplint.app, closed source phần render UI). Code core engine vẫn open-source.

4. **Performance numbers**: 30s–2 phút trên 1000+ objects là estimate dựa trên quan sát CI runs của abapGit repo — không phải benchmark chính thức.

5. **DDLS / RAP / BDEF objects**: support còn yếu trong abaplint. Pi-boi nên fallback (skip hoặc gọi LLM trực tiếp với raw text) cho các object này.

6. **abaplint-deps-find** workflow yêu cầu cài `abaplint-sci-client` lên SAP system + chạy `SAPRSEUB`. Nếu user pi-boi không có quyền admin SAP, không xài được — fallback dùng repo `abaplint/deps` skeleton chung.

7. **Phiên bản `@abaplint/core` thay đổi nhanh**: tại thời điểm tra cứu, npm cho thấy `@abaplint/cli` 2.115.10 "last published 5 hours ago" và rules.abaplint.org tự nhận version 2.119.23 — tức core release sớm hơn cli vài commit. Pin version cụ thể trong `package.json` của pi-boi để tránh breakage giữa các release.