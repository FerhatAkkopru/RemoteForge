# RemoteForge — Özel SSH/SFTP Uzak Dosya Sistemi Eklentisi

> Çalışma adı: **RemoteForge** (istersen değiştiririz). Amaç: Root/SSH ile bağlanılan sunuculardaki dosyaları VS Code içinde, sanki lokal bir workspace'miş gibi düzenlemek; kayıt anında **manuel onay** veya **otomatik senkron** seçeneği sunmak; ve mevcut eklentilerin zayıf olduğu noktaları (sessiz hata, çakışma tespiti yok, bakım riski) kapatmak.

---

## 0. Mimari Kararı: Neden `TreeDataProvider` Değil, `FileSystemProvider`?

Gemini'nin planı dosyayı SFTP'den çekip `vscode.workspace.openTextDocument` ile "sahte" bir belge olarak açmayı ve kaydı `onDidSaveTextDocument` event'iyle yakalamayı öneriyordu. Bu çalışır ama kırılgandır: dirty-state takibi, undo/redo, "Save As", çoklu sekme gibi davranışları elle simüle etmen gerekir.

Bunun yerine VS Code'un tam bu iş için var olan **`vscode.workspace.registerFileSystemProvider`** API'sini kullanacağız — Microsoft'un Remote-SSH'ı ve ciddi SFTP eklentileri de bunu kullanıyor. Böylece:

- Sunucu dizinini gerçek bir **workspace folder** (`ssh://host/path`) gibi açabiliyoruz. Dosya gezgini, arama, git entegrasyonu vs. hepsi native çalışır.
- `writeFile()` metodu VS Code tarafından **kayıt anında otomatik çağrılır** — onay/senkron mantığımızı tam buraya, tek bir yere koyabiliriz.
- `stat()` metodu ile dosyanın uzak `mtime`'ını her okumada/yazmada karşılaştırıp **çakışma tespiti**ni bedavaya alırız.

Bu, planın geri kalanının üstüne oturduğu temel mimari karar.

---

## 1. Teknoloji Yığını

| Katman | Seçim | Neden |
|---|---|---|
| Dil | TypeScript | VS Code Extension API'nin doğal dili |
| SSH/SFTP | `ssh2` (+ `@types/ssh2`) | Node.js için en olgun, aktif bakımlı SSH2 protokol kütüphanesi |
| Bundling | `esbuild` | Marketplace'in önerdiği modern, hızlı tek-dosya bundling yöntemi (raw `tsc` yerine) |
| Şifre/Anahtar Saklama | `vscode.SecretStorage` | İşletim sistemi keychain'ine şifreli yazar, düz metin `settings.json`'a asla yazmayız |
| Test | `@vscode/test-electron` + `mocha` | Resmi VS Code test çatısı |
| Paketleme | `vsce` (`@vscode/vsce`) | Marketplace'e yayın için standart araç |

---

## 2. Proje Dosya Yapısı

```
remoteforge/
├── .vscode/
│   ├── launch.json          # F5 ile Extension Development Host başlatma
│   └── tasks.json
├── src/
│   ├── extension.ts               # activate/deactivate, komut kayıtları
│   ├── connection/
│   │   ├── connectionManager.ts   # ssh2 Client yaşam döngüsü, reconnect
│   │   └── profileStore.ts        # Sunucu profilleri + SecretStorage entegrasyonu
│   ├── fs/
│   │   ├── remoteFileSystemProvider.ts  # vscode.FileSystemProvider implementasyonu
│   │   └── sftpClient.ts                # stat/readdir/readFile/writeFile/mkdir/delete/rename sarmalayıcı
│   ├── sync/
│   │   ├── syncEngine.ts          # manuel/otomatik onay akışı
│   │   └── conflictDetector.ts    # mtime/hash karşılaştırma
│   ├── ui/
│   │   ├── statusBar.ts           # bağlantı durumu göstergesi
│   │   ├── outputChannel.ts       # şeffaf log paneli (mevcut araçların en zayıf noktası)
│   │   └── quickPick.ts           # profil seçim/ekleme akışı
│   └── terminal/
│       └── remoteTerminal.ts      # (opsiyonel, Faz 9)
├── package.json
├── tsconfig.json
├── esbuild.js
├── .vscodeignore
├── .gitignore
├── README.md
└── LICENSE
```

---

## 3. Fazlar

### Faz 1 — İskelet & Geliştirme Ortamı
- `package.json`: `activationEvents`, `contributes.commands`, `contributes.configuration` tanımları.
- `esbuild.js` ile bundling pipeline.
- Boş bir "Hello World" komutuyla F5 → Extension Development Host'un açıldığını doğrulama.
- **Çıktı:** Çalışan, boş bir eklenti iskeleti.

### Faz 2 — Bağlantı & Kimlik Doğrulama
- `connectionManager.ts`: `ssh2.Client` ile `connect()/end()`, bağlantı durumu event'leri.
- `profileStore.ts`: Host/kullanıcı adı `settings.json`'da, şifre/anahtar **`SecretStorage`**'da saklanır (asla düz metin değil).
- Şifre + SSH anahtarı (private key + passphrase) ikisi de desteklenecek.
- Bağlantı koptuğunda üstel geri çekilmeli (exponential backoff) **otomatik yeniden bağlanma**.
- **Çıktı:** `RemoteForge: Connect to Server` komutu ile gerçek bir sunucuya bağlanabilme.

### Faz 3 — `RemoteFileSystemProvider`
- `sftpClient.ts`: ssh2'nin SFTP alt sistemini sararak `readdir`, `stat`, `readFile`, `writeFile`, `mkdir`, `delete`, `rename` fonksiyonları.
- `remoteFileSystemProvider.ts`: `FileSystemProvider` arayüzünü implemente edip `vscode.workspace.registerFileSystemProvider('ssh', provider)` ile kaydetme.
- `vscode.workspace.updateWorkspaceFolders` ile `ssh://host/path` şemasını workspace'e ekleme.
- **Çıktı:** Sunucu dizini, sol panelde gerçek bir proje ağacı gibi görünüyor; dosyaya tıklayınca native olarak açılıyor.

### Faz 4 — Senkronizasyon Motoru (Senin Orijinal Fikrin)
- Ayar: `remoteforge.syncMode`: `"auto" | "manual"`.
- **Otomatik mod:** `writeFile()` çağrıldığında doğrudan SFTP'ye yaz.
- **Manuel mod:** Yazma isteğini kuyruğa al, status bar'da "1 değişiklik bekliyor" göster, `Cmd+Shift+P → RemoteForge: Değişiklikleri Gönder` ile onay iste. Onay ekranında yerel/uzak diff'i `vscode.diff` komutu ile göster.
- **Çıktı:** Kaydettiğinde ya anında gider ya da onay bekler — ayar üzerinden seçilebilir.

### Faz 5 — Çakışma Tespiti (Piyasadaki Gerçek Boşluk)
- `conflictDetector.ts`: Her dosya açıldığında uzak `mtime` kaydedilir. Yazmadan hemen önce güncel `mtime` tekrar çekilip karşılaştırılır.
- Uyuşmazlık varsa: "Bu dosya sunucuda senden bağımsız değişmiş" uyarısı + "Üzerine yaz / Uzak sürümü getir / İptal" seçenekleri.
- **Çıktı:** Sessizce üzerine yazma riski ortadan kalkıyor — mevcut SFTP eklentilerinin çözmediği bir sorun.

### Faz 6 — Hata Yönetimi & Log Paneli
- `outputChannel.ts`: Her SFTP işlemi, bağlantı denemesi ve hatası **Output panelinde** zaman damgalı loglanır.
- Takılı kalan işlemler için timeout + otomatik iptal + kullanıcıya net hata mesajı (mevcut araçların en çok şikayet edilen açığı: sessizce donma).
- **Çıktı:** "Ne oluyor?" sorusuna her zaman cevap veren şeffaf bir sistem.

### Faz 7 — Çoklu Sunucu Profilleri
- `quickPick.ts`: Birden fazla sunucu profili arasında hızlı geçiş (`RemoteForge: Sunucuya Bağlan` → liste).
- Profiller `settings.json`'da host/user/port; şifre/anahtar `SecretStorage`'da profil ID'sine bağlı saklanır.

### Faz 8 — Terminal Entegrasyonu (Opsiyonel / Bonus)
- `ssh2`'nin `shell()` stream'i + `vscode.window.createTerminal` ile `Pseudoterminal` implementasyonu.
- Böylece dosya ağacı + entegre terminal aynı eklentide — mevcut SFTP-only araçların hiçbirinde yok.

### Faz 9 — Test, Paketleme, Yayın
- `@vscode/test-electron` ile temel entegrasyon testleri (bağlantı, dosya okuma/yazma, çakışma senaryosu).
- `README.md` + GIF demo + `LICENSE` (MIT) + `CHANGELOG.md`.
- `vsce package` ile `.vsix` üretimi, Marketplace'e yayın.
- GitHub/GitLab reposuna Buy Me a Coffee linki.

---

## 4. Kaba Efor Tahmini

| Faz | Tahmini Süre |
|---|---|
| 1 — İskelet | 0.5 gün |
| 2 — Bağlantı | 1–1.5 gün |
| 3 — FileSystemProvider | 2–3 gün (en kritik faz) |
| 4 — Senkron Motoru | 1–2 gün |
| 5 — Çakışma Tespiti | 1 gün |
| 6 — Hata/Log | 1 gün |
| 7 — Çoklu Profil | 0.5–1 gün |
| 8 — Terminal (bonus) | 1–2 gün |
| 9 — Test & Yayın | 1–2 gün |

Toplam ~9–14 gün (yarı zamanlı, portfolyo hızında).

---

## 5. Sıradaki Adım

Faz 1'i şimdi kuruyorum: `package.json`, `tsconfig.json`, `esbuild.js`, boş `extension.ts`, `.vscode/launch.json`. Kurulum bitince sana indirilebilir bir `.zip` olarak vereceğim; lokal makinende `npm install` çalıştırıp F5 ile deneyeceksin. Çalıştığını onayladıktan sonra Faz 2'ye geçeriz.