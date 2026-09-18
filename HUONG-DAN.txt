# Atlas English — bản Windows tối ưu

Đây là bản phát hành được tạo tự động từ code tại `D:\web-hoc-av` trên máy phát triển. Không sửa code trong thư mục bản phát hành hoặc trong ZIP.

## Máy phát triển

Sửa code tại `D:\web-hoc-av`, dùng `start-local.cmd` để chạy thử.

- `Tao-ban-client.cmd` ở thư mục code: kiểm tra, build, tạo bản tối ưu, EXE và ZIP. Không push.
- `Cap-nhat-GitHub.cmd` ở thư mục code: thực hiện cùng quy trình, sau đó kiểm tra dữ liệu riêng và push bản tối ưu lên GitHub.

Repo GitHub chỉ chứa bản đã build và bộ dữ liệu tối ưu. Không chứa cây code phát triển hoặc dữ liệu người dùng.

## Máy client

Chỉ cần nhận `AtlasEnglish.exe` và mở file. Lần đầu cần Internet để tải bộ chạy và ứng dụng. Bộ cài tự kiểm tra toàn vẹn, tạo lối tắt Desktop và chạy web local nền tại `http://localhost:3000`. Máy nhận không phải cài Git, Node.js, Python hoặc npm.

Nếu đã clone repo, mở `Mo-Atlas.cmd`. Các lần sau mở lối tắt Atlas English.

Có phiên bản mới: web hiện **Update ngay**. Bấm nút để tải, kiểm tra, sao lưu và chuyển phiên bản. Chỉ báo thành công sau khi bản mới khởi động; lỗi sẽ khôi phục bản trước. Lưu bài đang làm trước khi cập nhật.

43 đề, ảnh và audio được giữ nguyên chất lượng. Các tệp trùng dùng chung một bản; không cần tải lại media không đổi.

## Dữ liệu riêng

Client lưu dữ liệu ở `%LOCALAPPDATA%\AtlasEnglish\data`, bản sao lưu ở thư mục `backups` bên cạnh. Chúng nằm ngoài Git và không bị thay thế khi cập nhật.

Dữ liệu chạy thử trên máy phát triển nằm riêng tại `%LOCALAPPDATA%\AtlasEnglish-Dev`, không đi kèm bản phát hành. Tùy chọn/bản nháp trong trình duyệt vẫn chỉ nằm trên máy đang sử dụng.

Khóa AI do mỗi người tự nhập. AI và giọng neural cần Internet; bộ đề sau khi cài có thể dùng local. Các nút dừng, sao lưu và khôi phục thao tác trên bản client đã cài.

Việc phát hành có kiểm tra đường dẫn riêng tư, database, key phổ biến, checksum và danh sách tệp Git. Không hardcode key hoặc nội dung cá nhân vào code; bộ quét không thể nhận diện mọi thông tin cá nhân tùy ý.
