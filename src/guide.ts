export const GUIDE_TOPICS = ["overview", "record", "build", "viz", "stops", "drill", "progress", "rules", "embed"] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

export const GUIDE_DOCS: Record<GuideTopic, string> = {
  overview: `# Mira MCP: dò code từng dòng, đoán trước khi xem

Mira là phòng dò code trong hệ sinh thái học tập của người học (DuongNAD). Đặt theo Mira (omicron Ceti, "kỳ diệu"), ngôi sao biến quang đầu tiên được biết: độ sáng đổi theo thời gian, giống trạng thái chương trình đổi theo từng dòng.

Mira chạy mã Python thật dưới bộ dò (sys.settrace), ghi lại từng dòng được chạy cùng các biến thay đổi, rồi tạo MỘT tệp HTML tự chứa để phát lại từng dòng bên cạnh hình minh hoạ (mảng, lưới, đồ thị, vector trạng thái, đồ thị đường, bảng, ngăn xếp, hàng đợi, heap). Ở các điểm dừng, người học phải gõ dự đoán trước, rồi player mới hé lộ giá trị thật.

## Vì sao
Nghiên cứu về trực quan hoá thuật toán (Hundhausen, Douglas và Stasko 2002; Naps và cộng sự 2002) cho thấy chỉ xem thụ động giúp rất ít; học đến từ việc tham gia: dự đoán, trả lời, thay đổi. Đọc hiểu code chiếm 440/1000 điểm và gỡ lỗi 280/1000 điểm trong đề COS Pro cấp 2, nên dò code là kỹ năng được chấm nhiều nhất.

## Hệ sinh thái
| Dự án | Vai trò |
|---|---|
| Polaris | Lộ trình, Sổ lỗi (nhận lỗi dự đoán từ Mira) |
| Aurora Slides | Bài giảng; nhúng player Mira qua slide trace (giao thức mira-embed.v1) |
| Orion | Phòng thực hành; Mira dò chính tệp entry của bài lab (tham số lab) |
| Vega | Thẻ nhớ FSRS; Mira bỏ thẻ vào hộp thư .vega/inbox/ |
| SmartDrive-OS | Lập chỉ mục tệp Mira vừa ghi (hook post-write) |
| Mira | Dò code thật, điểm dừng dự đoán, nhật ký tiến độ |

## Quy trình
record -> đọc tóm tắt -> viết spec (1-3 viz, counters, 3-8 stops) -> mira_check -> mira_build -> mở player (mira_preview hoặc mở tệp) -> người học đoán ở từng điểm dừng -> mira_progress -> chuyển các điểm sai sang polaris_errorlog_add và hộp thư Vega.

Chủ đề khác: record, build, viz, stops, drill, progress, rules, embed.`,

  record: `# mira_record: ghi vết chạy thật

Tham số: file (tệp .py) hoặc lab (thư mục bài lab Orion), call (biểu thức gọi, ví dụ tong_chu_so(-4567)) hoặc script:true (chạy cả tệp như __main__), đúng một trong hai. Tuỳ chọn: focus (tên hàm cần dò; mặc định mọi hàm trong tệp, thêm mã mức module khi script), probes ({tên: biểu thức Python} tính tại mỗi dòng, lỗi cho null), stdin, max_steps (mặc định 2000, tối đa 20000), timeout_sec (mặc định 10, tối đa 120), out_dir (mặc định <thư mục tệp>/mira/<slug>/), name.

## Bộ dò
- Python chạy với -B -X utf8 (không sinh __pycache__), cwd là thư mục của tệp, bị diệt cả cây tiến trình khi hết giờ (taskkill /T /F trên Windows).
- Chỉ dò các khung (frame) thuộc tệp đích và nằm trong focus; thư viện bị bỏ qua.
- Mỗi sự kiện line ghi: dòng SẮP chạy, trạng thái biến trước khi dòng chạy, danh sách biến vừa đổi (changed), độ dài stdout đã in.
- Có sự kiện call (vào hàm), return (giá trị trả về), exception (loại và thông điệp).
- Giá trị được tuần tự hoá an toàn: int, float (nan/inf/số nguyên có dấu .0 được gắn thẻ), str (cắt dài), list/tuple/dict/set, complex, mảng numpy, đối tượng có __dict__. Số nguyên rất lớn giữ nguyên dạng chuỗi.
- Chạm max_steps thì ngừng ghi nhưng chương trình vẫn chạy nốt (kết quả vẫn có), truncated=true. Vòng lặp vô hạn bị diệt khi hết giờ và báo lỗi rõ; vết một phần vẫn được lưu để xem dòng nào lặp.

## Kết quả trả về
Số bước, hàm đã vào, 15 dòng chạy nhiều nhất, kết quả hoặc lỗi, đầu ra, biến đã thấy kèm kiểu, tối đa 6 điểm dừng gợi ý (biến tích luỹ ở vòng lặp, dòng return, rẽ nhánh).

## Mẹo
- Dùng focus để chỉ dò hàm chính khi có nhiều hàm phụ: vết nhỏ hơn, player nhẹ hơn.
- Vết dài hơn 5000 bước bị cắt khi nhúng vào player; hãy ghi ngắn lại.`,

  build: `# mira_build / mira_check: từ vết thành player

Spec:
\`\`\`json
{
  "title": "Tổng chữ số", "subtitle": "tong_chu_so(-4567)", "course": "Python", "lesson": "Bài 1.03",
  "trace": "<đường dẫn trace.json>", "out_dir": "<thư mục, mặc định cạnh trace>", "theme": "dark",
  "viz": [{"kind": "array", "var": "arr", "pointers": ["i"]}],
  "counters": [{"label": "TỔNG", "expr": "tong"}, {"label": "Vòng lặp", "line_hits": 5}],
  "stops": [{"at": {"line": 6, "hit": 2}, "ask": "Sau dòng này tong bằng bao nhiêu?", "expect": {"expr": "tong"}}],
  "narration": {"6": "Cộng chữ số cuối vào tổng."},
  "start_step": 0, "autoplay_ms": 600
}
\`\`\`
- expr chỉ là tên biến, tên probe hoặc len(<tên>): tính trên trạng thái đã ghi, không chạy Python khi phát lại.
- mira_check kiểm tra spec với vết mà không ghi gì: dòng điểm dừng phải đã chạy đủ lần, expr phải có giá trị tại điểm đó, biến của viz phải xuất hiện trong vết; lỗi có gợi ý "Có phải ...?". Tổng HTML tối đa 3 MB (vết quá 5000 bước bị cắt kèm cảnh báo).
- Kết quả mira_build có thêm đoạn JSON slide trace để dán vào deck Aurora (Mira không tự ghi vào thư mục deck).
- Player chạy ngoại tuyến từ file:// (không CDN, phông nhúng sẵn).
- Phím: ← → bước, Space chạy/dừng, Home/End, N tới điểm dừng tiếp theo. Đường dẫn index.html#stop-3 mở đúng điểm dừng 3.`,

  viz: `# Các loại viz (tối đa 3 mỗi player)

| kind | Tham số | Hiển thị |
|---|---|---|
| array | var, pointers?, title? | số thành cột, giá trị khác thành ô; pointers là tên biến chỉ số (i, j, lo, hi) |
| grid | var? (danh sách 2 chiều) hoặc rows+cols, walls?, visited?, frontier?, path?, current?, start?, goal?, title? | canvas; tập/danh sách cặp [r,c]; frontier có thể là heap chứa tuple có phần tử cuối là [r,c]; ô khác 0 của var là tường |
| graph | nodes (dict id -> {x,y,label?}) hoặc adjacency (dict id -> danh sách id hoặc [id, w]), visited?, frontier?, current?, labels?, title? | SVG, bố cục vòng tròn khi không có x,y |
| statevector | var, title? | cột xác suất |amp|^2 với nhãn |00>, |01>, pha hiển thị bằng mặt đồng hồ nhỏ, nút chuyển sang bảng biên độ |
| plot | var (danh sách số), title?, y_label? | đường vẽ danh sách khi nó dài ra |
| table | var (dict hoặc list), title? | bảng, ô đổi nhấp nháy nhẹ |
| stack / queue / heap | var, title? | các hộp; heap còn vẽ cây nhị phân |

Gợi ý chọn: thuật toán duyệt lưới dùng grid; sắp xếp/tìm kiếm trên mảng dùng array với pointers; đồ thị dùng graph với visited và frontier; mô phỏng lượng tử dùng statevector.
Counters (tối đa 4): {label, expr} hoặc {label, line_hits} (số lần một dòng đã chạy).
Không có viz: player hiện "bảng dò vết" kiểu đề thi (mỗi cột là một biến số của hàm, mỗi dòng xuất hiện khi giá trị đổi) và không bao giờ hiện kết quả trước khi chạy tới.`,

  stops: `# Điểm dừng (cổng dự đoán)

\`\`\`json
{ "at": {"line": 12, "hit": 2}, "ask": "Sau dòng này, tong bằng bao nhiêu?",
  "expect": {"expr": "tong"}, "explain": "Giải thích hiện sau khi đoán.", "tolerance": 1e-9 }
\`\`\`
- at: {line, hit} (lần thứ hit dòng đó sắp chạy, mặc định 1) hoặc {step} (chỉ số sự kiện trong vết).
- expect.expr được tính trên trạng thái SAU khi dòng chạy (sự kiện kế tiếp của cùng khung), hoặc dùng expr "return" để hỏi giá trị dòng return trả về. expect.line_next hỏi dòng nào chạy tiếp theo. expect.choice + answer là câu trắc nghiệm (2-6 lựa chọn).
- Người học gõ literal Python: số, True/False/None, chuỗi có/không nháy, list, tuple, dict, set. 3 và 3.0 bằng nhau (sai số tương đối 1e-9); list và tuple bằng nhau khi các phần tử bằng nhau; set và dict không phân biệt thứ tự.
- Phát lại tới điểm dừng (đi tiến, lần đầu) thì player tự dừng và hỏi. "Bỏ qua" tính là một lần chưa đúng; tua qua điểm dừng chưa trả lời cũng đánh dấu bỏ qua.
- Đặt 3-8 điểm dừng ở những dòng mang ý tưởng: biến tích luỹ ở vòng lặp, rẽ nhánh, giá trị trả về, ranh giới (rỗng, phần tử đầu/cuối). Không hỏi thứ đang hiện sẵn trên màn hình.`,

  drill: `# mira_drill: luyện đọc hiểu code cho kỳ thi

\`\`\`
mira_drill { file | lab, function?, call?, stops? (mặc định 4, tối đa 8), out_dir?, title? }
\`\`\`
- Nếu thiếu call, lấy ví dụ đầu tiên trong docstring dạng \`f(args) -> kết quả\` hoặc \`f(args) == kết quả\`; không có thì báo lỗi yêu cầu truyền call.
- TỪ CHỐI hàm còn chỗ trống ___1___, ___2___: "Hoàn thành chỗ trống trước khi dò code." Mira dò code đã có, không bao giờ viết lời giải thay người học.
- Dò hàm đó (kèm hàm lồng bên trong), chọn điểm dừng: dòng return (hỏi giá trị trả về) và tối đa (stops - 1) lần cập nhật biến tích luỹ trong vòng lặp (lần đầu, giữa, cuối).
- Viz: array cho tham số danh sách đầu tiên (kèm con trỏ i, j...), table cho dict. Counter "Vòng lặp" khi có vòng lặp.
- Kết quả: đường dẫn player và danh sách câu hỏi (không kèm đáp án).`,

  progress: `# mira_progress: đọc tiến độ và chuyển sang hệ sinh thái

\`\`\`
mira_progress { dir? | file?, to_vega?, hub? }
\`\`\`
- Nguồn: <dir>/progress.jsonl (do mira_preview ghi khi player chạy qua http), các tệp aurora-progress-mira-*.jsonl cạnh đó, hoặc một tệp đã xuất bằng nút "Xuất tiến độ" (file).
- Tóm tắt theo player: số câu đã trả lời, đúng, khác dự đoán, bỏ qua, độ chính xác, hoạt động gần nhất, danh sách điểm dừng chưa đúng (câu hỏi, dự đoán, giá trị thật).
- JSON xuất: errorLogEntries (cho polaris_errorlog_add: why "Dự đoán sai khi dò code: ...") và vegaCards (cho vega_add). Mira không ghi vào thư mục Polaris.
- to_vega:true ghi MỘT tệp vào <hub>/.vega/inbox/ theo hợp đồng vega-card-inbox.v1 (producer mira, key mira:<slug>:stop-<k>, origin mira-stop, href tới index.html#stop-<k>) cho mọi điểm dừng sai hoặc bỏ qua. hub lấy từ tham số hub, rồi MIRA_HUB, POLARIS_HUB, mặc định D:/02_Learning_Knowledge. Gọi lại nhiều lần an toàn vì Vega loại thẻ trùng theo key.
- Tệp progress.jsonl và aurora-progress-*.jsonl thuộc hợp đồng personal-data (không đưa lên git).`,

  rules: `# Quy tắc của Mira

1. Chỉ vết thật: mọi giá trị hiển thị đến từ lần chạy thật của mã Python; Mira không dựng bước hay giá trị.
2. Không bao giờ viết lời giải cho bài của người học. Demo duy nhất là A* và Dijkstra trên lưới (không thuộc bài tập). mira_drill từ chối hàm còn ___n___.
3. Câu hỏi đặt trước khi tiết lộ; không hỏi thứ đang hiện sẵn trên màn hình.
4. Chữ hiển thị cho người học bằng tiếng Việt có dấu, không emoji; biểu tượng là SVG nội tuyến.
5. Player ngoại tuyến: không CDN, không URL ngoài; phông nhúng dưới dạng data URI.
6. Python luôn chạy với -B -X utf8, có giới hạn thời gian và bị diệt cả cây tiến trình; stdout/stderr bị giới hạn.
7. Không quét đệ quy ổ D:; không npm install trên D:; fixture và đầu ra thử nghiệm đặt ở thư mục tạm.
8. Biến môi trường: MIRA_PYTHON (Python), MIRA_TOOLCHAIN (build), MIRA_HUB (hộp thư Vega), MIRA_SMARTDRIVE=off để tắt hook SmartDrive, MIRA_SMARTDRIVE_CMD để đổi lệnh.`,

  embed: `# Giao thức mira-embed.v1 (nhúng player vào slide Aurora)

Chế độ nhúng bật khi window.parent !== window hoặc URL có ?embed=1: bố cục gọn lấp đầy iframe (thanh tiêu đề mỏng; bộ đếm, viz, mã, biến và điều khiển vẫn hiện ở 1280x720 và 960x540), phím tắt chỉ hoạt động khi tài liệu iframe đang có focus, Escape gửi {source:"mira", v:1, kind:"blur"} để deck lấy lại focus.

Player gửi tới window.parent.postMessage(..., "*"):
- Khi tải xong: {source:"mira", v:1, kind:"ready", title, steps, stops}
- Mỗi sự kiện tiến độ (predict mỗi điểm dừng, complete ở cuối): {source:"mira", v:1, kind:"event", event:<aurora-progress-event.v1>}. Trong chế độ nhúng KHÔNG POST tới /__mira/progress (deck sở hữu việc lưu); bộ đệm localStorage vẫn giữ.

Player nhận: {source:"aurora", v:1, kind:"hello", theme:"dark"|"light", accent?:"#RRGGBB"} (kiểm tra mã màu hex; mọi thông điệp có source khác "aurora" bị bỏ qua).

Sự kiện: slideId "mira-stop-<k>" (k từ 1), title là câu hỏi, deck là tiêu đề player, course và lesson lấy từ spec hoặc lab.json.
Mỗi player có <meta name="generator" content="mira-mcp 0.1.0"> và <meta name="mira-player" content="1">.`,
};

export function getGuideTopic(topic?: string): string {
  if (!topic || !topic.trim()) {
    return `# Hướng dẫn sử dụng Mira MCP (Mira Guide)

Chọn một chủ đề để xem chi tiết:
- \`overview\`: Mira là gì, vì sao, hệ sinh thái, quy trình.
- \`record\`: ghi vết chạy thật (call/script, focus, probes, giới hạn).
- \`build\`: spec build, mira_check, player ngoại tuyến, phím tắt.
- \`viz\`: các loại hình minh hoạ và tham số.
- \`stops\`: điểm dừng dự đoán và cách so sánh câu trả lời.
- \`drill\`: luyện đọc hiểu code cho kỳ thi (từ chối chỗ trống).
- \`progress\`: tiến độ, xuất sang Polaris và hộp thư Vega.
- \`rules\`: các quy tắc bất biến.
- \`embed\`: giao thức nhúng vào Aurora (mira-embed.v1).

*Ví dụ CLI:* \`node dist/mira.mjs guide stops\`
*Ví dụ MCP:* \`mira_guide { topic: "stops" }\``;
  }
  const t = topic.trim().toLowerCase() as GuideTopic;
  const doc = GUIDE_DOCS[t];
  if (doc) return doc;
  return `Chủ đề '${topic}' không tồn tại. Các chủ đề khả dụng: ${GUIDE_TOPICS.join(", ")}`;
}
