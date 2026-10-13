[English](README.md) | Tiếng Việt

<p align="center"><img src="docs/banner.jpg" alt="Mira MCP — Mira, the wonderful variable star, trailing its long tail" width="100%"></p>

# Mira MCP

*Được đặt tên theo Mira (omicron Ceti, "kỳ diệu"), ngôi sao biến quang đầu tiên được biết: độ sáng đổi theo thời gian, giống trạng thái chương trình đổi theo từng dòng.*

Mira là phòng dò code trong hệ sinh thái MCP của người học. Mira chạy **mã Python thật** dưới một bộ dò, ghi lại từng dòng được chạy cùng các biến thay đổi, rồi tạo **một tệp HTML tự chứa** để phát lại từng dòng bên cạnh hình minh hoạ trực tiếp (mảng, lưới, đồ thị, vector trạng thái, đường biểu diễn, bảng, ngăn xếp, hàng đợi, heap). Ở những điểm dừng do bạn chọn, người học phải **gõ dự đoán trước khi player hé lộ kết quả**.

---

## Hệ sinh thái

Toàn bộ dự án phát triển bởi DuongNAD:

| Dự án | Vai trò | Kho lưu trữ (Repository) |
| :--- | :--- | :--- |
| **Polaris** | Kiến trúc sư lộ trình; nhận các dự đoán sai của Mira vào Sổ lỗi | [polaris-mcp](https://github.com/DuongNAD/polaris-mcp) |
| **Aurora Slides** | Động cơ bài giảng; nhúng player Mira vào slide `trace` | [aurora-slides-mcp](https://github.com/DuongNAD/aurora-slides-mcp) |
| **SmartDrive-OS** | Quản trị SSD và tìm kiếm tài liệu; lập chỉ mục những gì Mira ghi | [smart-drive-os](https://github.com/DuongNAD/smart-drive-os) |
| **Constellation** | Đăng ký MCP và hợp đồng hệ sinh thái | [constellation-mcp](https://github.com/DuongNAD/constellation-mcp) |
| **Vega** | Ghi nhớ giãn cách thích ứng (FSRS); nhận thẻ ôn tập qua hộp thư | [vega-mcp](https://github.com/DuongNAD/vega-mcp) |
| **Orion** | Phòng thực hành và thang gợi ý; Mira dò tệp entry của bài lab | [orion-mcp](https://github.com/DuongNAD/orion-mcp) |
| **Mira** | Vết chạy thật, điểm dừng dự đoán, nhật ký tiến độ | [mira-mcp](https://github.com/DuongNAD/mira-mcp) |

---

## Vì sao cần Mira?

Người học đã xem một video ngắn minh hoạ A* từng dòng và muốn có công cụ tương tự cho việc học của mình. Nghiên cứu về trực quan hoá thuật toán và chương trình cho thấy chỉ xem thụ động giúp rất ít; học đến từ **sự tham gia** (dự đoán, trả lời, thay đổi) ở từng bước (Hundhausen, Douglas và Stasko 2002; Naps và cộng sự 2002). Dò code cũng là kỹ năng được chấm nhiều nhất trong kỳ thi của người học: COS Pro cấp 2 dành 440/1000 điểm cho đọc hiểu code và 280/1000 điểm cho gỡ lỗi.

Vì vậy Mira là bộ dò *chủ động*: vết thật, cổng dự đoán, và kết quả được ghi theo định dạng tiến độ của hệ sinh thái (`aurora-progress-event.v1`) để Polaris (Sổ lỗi) và Vega (thẻ nhớ) dùng lại.

---

## Nguyên tắc

1. **Chỉ chạy thật**: mọi giá trị hiển thị đến từ vết ghi của mã Python của người học. Mira không bao giờ dựng bước hay giá trị.
2. **Không bao giờ đưa lời giải**: Mira dò mã đã có. `mira_drill` từ chối hàm còn chỗ trống (`___1___`). Demo duy nhất là A* và Dijkstra trên lưới, không thuộc bài tập của người học.
3. **Đoán trước**: điểm dừng hỏi trước khi tiết lộ.
4. **Ngoại tuyến**: player chạy hoàn toàn từ `file://`; không CDN, không URL ngoài nào trong HTML tạo ra (phông chữ nhúng sẵn).
5. **Hợp người học**: chữ hiển thị bằng tiếng Việt có dấu, không emoji (biểu tượng là SVG nội tuyến), giao diện tối dịu mặc định.
6. **Vệ sinh tiến trình**: Python chạy với `-B -X utf8` (không sinh `__pycache__` trên ổ exFAT), cwd là thư mục của tệp được dò, có giới hạn thời gian, bị diệt cả cây tiến trình khi quá hạn (`taskkill /PID <pid> /T /F` trên Windows), stdout/stderr bị giới hạn.
7. **Kỷ luật công cụ**: TypeScript strict, một tệp đóng gói esbuild `dist/mira.mjs`, toolchain ngoài qua `MIRA_TOOLCHAIN`, không có `node_modules` trên ổ D:.

---

## Công cụ MCP và lệnh CLI

| Công cụ MCP | Lệnh CLI | Chức năng |
|---|---|---|
| `mira_guide {topic?}` | `mira guide [topic]` | overview, record, build, viz, stops, drill, progress, rules, embed |
| `mira_record {file \| lab, call \| script, ...}` | `mira record <file> --call "<expr>" \| --script` | Chạy dưới bộ dò, ghi `trace.json`, tóm tắt và gợi ý điểm dừng |
| `mira_build {spec}` | `mira build <spec.json>` | Kiểm tra spec với vết, ghi `index.html`, in slide cho Aurora |
| `mira_check {spec}` | `mira check <spec.json>` | Chỉ kiểm tra (không ghi), kèm gợi ý sửa |
| `mira_drill {file \| lab, function?, call?, stops?}` | `mira drill <file> [function]` | Luyện thi: ghi vết và chọn điểm dừng trong một lệnh |
| `mira_demo {out_dir?}` | `mira demo [out_dir]` | A* so với Dijkstra trên lưới 18x28, trang tổng hợp so số ô đã xét |
| `mira_preview {dir, port?, stop?}` | `mira preview <dir> [--port n]` | Máy chủ 127.0.0.1; POST `/__mira/progress` ghi vào `progress.jsonl` |
| `mira_progress {dir? \| file?, to_vega?, hub?}` | `mira progress <dir\|file> [--to-vega] [--hub p]` | Tóm tắt, mục Sổ lỗi, thẻ Vega và hộp thư |

Mọi lệnh CLI đều nhận `--json`.

---

## Bắt đầu nhanh

```powershell
$env:MIRA_TOOLCHAIN = "C:\Users\Admin\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\aurora-slides\toolchain"
node scripts/build.mjs --check      # kiểm tra kiểu (node + player/DOM) và đóng gói
node scripts/e2e.mjs                # MCP stdio thật, CLI, máy chủ xem trước, kiểm thử player
node dist/mira.mjs demo $env:TEMP\mira-demo
node dist/mira.mjs drill duong\dan\bai_tap.py ten_ham --out $env:TEMP\my-drill
```

### Ghi vết và tạo player

```text
mira_record { file: "p1.py", call: "tong(-4567)", probes: { sq: "tong*tong" } }
mira_check  { spec }
mira_build  { spec }
```

```json
{
  "title": "Tổng chữ số",
  "trace": "<đường dẫn trace.json>",
  "viz": [{ "kind": "array", "var": "chu_so", "pointers": ["i"] }],
  "counters": [{ "label": "TỔNG", "expr": "tong" }, { "label": "Vòng lặp", "line_hits": 5 }],
  "stops": [
    { "at": { "line": 6, "hit": 2 }, "ask": "Sau dòng này, `tong` bằng bao nhiêu?", "expect": { "expr": "tong" }, "explain": "..." },
    { "at": { "line": 8 }, "ask": "Hàm trả về gì?", "expect": { "expr": "return" } }
  ],
  "narration": { "6": "Cộng chữ số cuối vào tổng." }
}
```

- `expr` là tên biến, tên probe hoặc `len(<tên>)`, chỉ tính trên trạng thái đã ghi (không chạy Python khi phát lại). Trong `expect.expr`, từ `return` là giá trị mà dòng của điểm dừng trả về.
- Điểm dừng: `value` (`expect.expr`), `line` (`expect.line_next`: dòng nào chạy tiếp) hoặc `choice` (`expect.choice` + `answer`).
- Loại viz: `array`, `grid`, `graph`, `statevector`, `plot`, `table`, `stack`, `queue`, `heap` (tối đa 3 mỗi player, hiện thành các tab).
- Counter có thể dùng `line_hits` (số lần một dòng đã chạy) thay cho `expr`.

### Player

Tối dịu mặc định (có nút đổi sáng/tối), hai cột (mã nguồn 1.45fr, ngăn trạng thái 1fr), viền mảnh hairline, phong cách Apple-keynote tinh gọn. Ngăn mã tự xuống dòng (không tràn ngang), thanh nhấn dòng đang chạy và chú thích ở chân ngăn; bảng biến nháy nhẹ khi giá trị đổi; đầu ra stdout; thanh tua với các chấm điểm dừng; thanh điều khiển tối giản.

Khi không cấu hình viz (thường gặp ở bài luyện số học), khung bên trái hiện **bảng dò vết** kiểu đề thi; các dòng chỉ xuất hiện khi lần chạy tới đó (không bao giờ lộ kết quả trước).

Phím: `Trái`/`Phải` bước, `Space` chạy/dừng, `Home`/`End`, `N` tới điểm dừng tiếp theo. Tôn trọng chế độ giảm chuyển động. `index.html#stop-3` mở player đúng điểm dừng 3 (thẻ ôn tập của Vega dùng để quay lại).

Tới điểm dừng, player tự dừng và hỏi. Người học gõ literal Python (`7`, `[1, 2]`, `'abc'`, `True`, dict hoặc set); `3` bằng `3.0`, `[1, 2]` bằng `(1, 2)`, chuỗi được cắt khoảng trắng, set và dict không phân biệt thứ tự. Phần hé lộ hiện `Đúng` hoặc `Khác dự đoán`, giá trị thật và lời giải thích. "Bỏ qua" (hoặc tua qua điểm dừng) được ghi là một lần chưa đúng.

---

## Tích hợp hệ sinh thái

| Tích hợp | Cách làm |
|---|---|
| **Hợp đồng tiến độ** | Mỗi điểm dừng: `{v:1, t, course, lesson, deck, slide, slideId:"mira-stop-<k>", type:"predict", title, prediction, rating:"right"\|"different", output}`; cuối cùng một lần `{type:"complete", slides, quiz:null, predictions:"x/y"}`. Lưu vào `localStorage` (`mira:<slug>:events`, 1000 mục), POST tới `/__mira/progress` khi phục vụ qua http, và xuất bằng nút "Xuất tiến độ" thành `aurora-progress-mira-<slug>.jsonl`. |
| **Nhúng vào Aurora** (`mira-embed.v1`) | Chế độ nhúng bật khi `window.parent !== window` hoặc `?embed=1`: bố cục gọn, phím tắt chỉ chạy khi iframe có focus, `Escape` gửi `{source:"mira",v:1,kind:"blur"}`; player gửi `ready` và mọi `event` lên cửa sổ cha (không POST `/__mira/progress`) và nhận `{source:"aurora",v:1,kind:"hello",theme,accent}`. `mira_build` trả về slide sẵn để dán `{"type":"trace","eyebrow":"Dò code","title","player","caption"}`; Mira không bao giờ ghi vào thư mục deck của Aurora. |
| **Bài lab Orion** | `lab` trỏ tới thư mục lab: Mira dò `<lab>/<entry>`; sự kiện dùng `course = lab.subject`, `lesson = lab.module \|\| lab.title`. |
| **Polaris** | `mira_progress` trả về `errorLogEntries` (`why: "Dự đoán sai khi dò code: <câu hỏi>"`) để đưa vào `polaris_errorlog_add`. Mira không ghi vào thư mục Polaris. |
| **Vega** | `vegaCards` cho `vega_add`, hoặc `to_vega: true` bỏ MỘT tệp `vega-card-inbox.v1` vào `<hub>/.vega/inbox/` (producer `mira`, key `mira:<slug>:stop-<k>`, origin `mira-stop`, `href` tới `index.html#stop-<k>`). Hub lấy từ tham số `hub`, `MIRA_HUB`, `POLARIS_HUB`, rồi `D:/02_Learning_Knowledge`. |
| **SmartDrive** | Sau khi ghi đầu ra trên ổ SmartDrive, Mira chạy nền `smart-drive update <dir> --quiet` (tách tiến trình, chống lặp, bỏ qua lỗi). Tắt bằng `MIRA_SMARTDRIVE=off`; đổi lệnh bằng `MIRA_SMARTDRIVE_CMD`. |

`progress.jsonl` và `aurora-progress-*.jsonl` thuộc hợp đồng `personal-data` (không đưa lên git).

---

## Định dạng vết

`trace.json`: `{v:1, tool:"mira", file, call|script, created, python, focus, steps, result?, resultValue?, stdout, stderr, error?, truncated, lines, source, ...}`. Các bước là sự kiện `call`, `line` (`{i, line, func, depth, fid, locals, types, changed, probes?, out}` với `line` là dòng SẮP chạy và `locals` là trạng thái trước khi dòng đó chạy), `return` và `exception`. Giá trị: số nguyên, số thực (số thực nguyên và không hữu hạn được gắn thẻ để `3.0` vẫn là float), bool, `None`, chuỗi, list, tuple, dict, set, complex, mảng numpy, đối tượng có `__dict__`; container lớn bị cắt nhưng giữ độ dài thật.

Player nhúng vết dưới dạng gọn: mỗi bước chỉ chứa biến đã đổi, cùng bản vá ở mức container (tập `visited` lớn lên một phần tử mỗi bước chỉ tốn một phần tử, không phải một bản sao).

Biến môi trường: `MIRA_PYTHON` (Python 3), `MIRA_TOOLCHAIN`, `MIRA_HUB`, `MIRA_SMARTDRIVE`, `MIRA_SMARTDRIVE_CMD`. Thứ tự tìm Python: `MIRA_PYTHON` -> `python` -> `py -3`.

---

## Phát triển

```powershell
node scripts/build.mjs --check   # tsc strict (cấu hình node) + tsc strict (thư viện DOM cho src/player)
node scripts/e2e.mjs             # fixture ở %TEMP%; player chạy trên DOM giả, và vài kiểm tra bố cục chạy trong
                                 # Chrome headless nếu máy có Chrome (không có thì bỏ qua và báo)
node scripts/shots.mjs           # QA bố cục trong Chrome headless có giả lập thiết bị thật: bảng tràn ngang và ảnh
                                 # chụp ở %TEMP%\mira-shots (tuỳ chọn: --fixtures --sweep --only --reuse)
```

`scripts/shots.mjs` điều khiển Chrome qua giao thức DevTools bằng WebSocket có sẵn của Node (không cần gói npm) và một hồ sơ tạm. Hãy dùng nó thay cho `chrome --headless --window-size=390,844`: Chrome trên Windows không tạo cửa sổ hẹp hơn khoảng 500 px, nên lệnh đó cho ra bố cục rộng hơn bị cắt còn 390 px, trông như bị tràn nhưng thực ra không.

---

## Bản quyền

Giấy phép MIT (c) 2026 DuongNAD
