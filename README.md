# Web khoá học SCORM

Một trang web có danh sách khoá học SCORM (1.2 & 2004). Bạn gửi link cho người khác, họ bấm vào là học được ngay — không cần đăng nhập, không cần LMS. Lưu trữ miễn phí trên **GitHub Pages**.

- Trang chủ: `https://<tên-tài-khoản>.github.io/<tên-repo>/`
- Link thẳng tới 1 khoá: `https://<tên-tài-khoản>.github.io/<tên-repo>/?course=<mã-khoá>` (nút **🔗 Chia sẻ** trong trang sẽ sao chép link này)

## Thêm / xoá khoá học

Chỉ cần bỏ file `.zip` SCORM vào thư mục **`courses/`** trên GitHub (hoặc xoá file khỏi đó). Khoảng 1–2 phút sau web tự cập nhật.

- Tên khoá học hiển thị lấy từ `imsmanifest.xml`; mã trong link lấy từ tên file zip (ví dụ `An toàn lao động.zip` → `?course=an-toan-lao-dong`). **Đừng đổi tên file zip** sau khi đã gửi link, nếu không link cũ sẽ hỏng.
- Thứ tự trên trang theo tên file (có thể đặt `01 - ...zip`, `02 - ...zip`).
- Cũng có thể bỏ vào `courses/` một **thư mục** đã giải nén (có `imsmanifest.xml`) thay cho file zip.

Giới hạn của GitHub: tải lên qua trình duyệt tối đa 25 MB/file (dùng GitHub Desktop thì 100 MB/file); toàn bộ web nên dưới 1 GB.

## Đổi tên trang

Sửa chữ `Khoá học trực tuyến` (2 chỗ) trong `index.html`.

## Chạy thử trên máy

```bash
python3 scripts/build.py
python3 -m http.server 8080 -d _site
```
Mở http://localhost:8080

## Lưu ý
- Tiến độ học (bài đã xong, điểm) được lưu **trên trình duyệt của từng người học**. Bạn (chủ web) **không xem được** kết quả của họ. Muốn theo dõi kết quả cần thêm máy chủ/LMS.
- Repo GitHub để dùng Pages miễn phí phải ở chế độ **Public** → ai cũng có thể tải các file khoá học về.

## Cấu trúc
- `courses/` — nơi để các gói SCORM
- `scripts/build.py` — giải nén khoá học, tạo danh mục `courses.json`
- `.github/workflows/deploy.yml` — GitHub tự chạy build và đăng web mỗi khi bạn thay đổi
- `index.html`, `style.css`, `app.js`, `scorm-api.js`, `sw.js`, `vendor/` — giao diện & trình phát SCORM
