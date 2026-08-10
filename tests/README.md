# booking.html 的自動化檢查

用 jsdom 直接載入 `../booking.html` 並實際操作表單，涵蓋：人數增減時同行旅客
欄位的產生與保值、三種語言的字典完整性（避免 `alert()` 顯示 undefined）、
必填驗證、送出的 `notes` 名冊格式、日期不能差一天、以及 LINE 登入來回的
草稿存還原。

```bash
cd tests && npm install && npm test
```

跑不到的部分（需要真的登入或真的 Airtable）仍然只能請店家在線上實測，
清單見 skill 文件的「改動後的驗證清單」。
