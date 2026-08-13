# RemoteForge

[English](#remoteforge-english) | [Türkçe](#remoteforge-türkçe)

---

<a name="remoteforge-english"></a>
# RemoteForge (English)

RemoteForge is a lightweight, reliable VS Code extension for directly editing remote files over SSH/SFTP as if they were local workspace files.

Engineered to resolve common pain points found in existing SFTP extensions, such as **silent UI hangs**, **accidental file overwrites**, and **slow directory browsing latency**.

## 💡 Key Features

- **No UI Freezes (Native FileSystemProvider):** Integrates remote directories into VS Code using a custom `remoteforge://` URI scheme. Keeps the editor responsive even during network hiccups.
- **Instant Directory Browsing (Smart Stat Cache):** Pre-caches child metadata during directory reads (`READDIR`). Sub-queries for file stats hit RAM instantly (0 ms latency) rather than triggering individual network roundtrips.
- **Prevents Data Overwrites (Conflict Detection):** Monitors file modification timestamps (`mtime`) to warn you before overwriting files modified externally on the remote server.
- **Production Safety (Manual Sync Mode):** Choose between instant auto-upload or queuing changes locally for explicit batch approval (`Push Pending Changes`).
- **Credential Security:** Passwords and SSH keys are stored in the operating system's native keychain using VS Code `SecretStorage` — never written to disk or `settings.json`.

## 🛠 Architecture & Request Flow

```
VS Code Explorer ──> RemoteFileSystemProvider ──> Smart Stat Cache ──> SftpClient ──> ConnectionManager (SSH2) ──> Remote Server
```

1. **ConnectionManager:** Handles SSH2 lifecycle and exponential backoff reconnection strategies.
2. **Channel Deduplication:** Reuses a single SFTP subsystem channel across concurrent operations to prevent SSH channel open failures.
3. **Connection Gate:** Holds incoming file requests synchronously during activation until the SSH handshake resolves.

## 🚀 Quick Start (Development)

1. Clone the repository and install dependencies:
   ```bash
   git clone git@github.com:FerhatAkkopru/RemoteForge.git
   cd RemoteForge
   npm install
   ```

2. Compile the extension:
   ```bash
   node ./node_modules/.bin/tsc
   node esbuild.js
   ```

3. Open the project in VS Code and press **`F5`** to launch the Extension Development Host.

## 📖 Usage Guide

1. **Add Server Profile:** Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`), run **`RemoteForge: Add Server Profile`**, and enter host, port, credentials, and profile name.
2. **Connect to Server:** Run **`RemoteForge: Connect to Server`**, pick your profile, and enter the remote absolute path (e.g. `/` or `/var/www`).
3. **View Logs:** Run **`RemoteForge: Show Log`** to view real-time timestamped connection and SFTP operation logs in the Output panel.

## ⌨️ Registered Commands

| Command | Description |
| :--- | :--- |
| `RemoteForge: Connect to Server` | Connects to a server and mounts a remote directory as workspace. |
| `RemoteForge: Disconnect` | Terminates active SSH connection and unmounts remote folder. |
| `RemoteForge: Add Server Profile` | Launches profile setup wizard for new server credentials. |
| `RemoteForge: Delete Server Profile` | Removes saved profile and stored secret key from OS keychain. |
| `RemoteForge: Push Pending Changes` | Flushes queued local modifications to remote server (Manual Mode). |
| `RemoteForge: Show Log` | Focuses the extension's dedicated log channel in Output view. |

---

<a name="remoteforge-türkçe"></a>
# RemoteForge (Türkçe)

RemoteForge, uzak sunuculardaki (SSH/SFTP) dosyaları VS Code içerisinden yerel dosya gibi doğrudan ve güvenli bir şekilde düzenlemenizi sağlayan hafif bir VS Code eklentisidir.

Piyasadaki SFTP eklentilerinde sıkça karşılaşılan **donma (silent hang)**, **dosya ezilmesi (overwriting)** ve **yavaş klasör yükleme** problemlerini çözmek için geliştirilmiştir.

## 💡 Neden RemoteForge?

- **Donma Yok (Native FileSystemProvider):** Uzak dosyaları VS Code sanal dosya sistemi (`remoteforge://`) olarak kaydeder. Ağ kesilse bile VS Code kilitlenmez.
- **Şak Diye Açılan Klasörler (Smart Stat Cache):** Klasör açıldığında tüm alt dosyaların meta verileri tek ağ sorgusunda önbelleğe alınır. Klasör gezintisi 0 ms gecikmeyle çalışır.
- **Sessiz Veri Kaybını Önler (Conflict Detection):** Sunucuda başka biri dosyayı değiştirdiyse `mtime` (değiştirilme tarihi) takibi ile sizi uyarır ve üzerine yazmayı engeller.
- **Üretim Sunucuları İçin Güvenli (Manual Sync Mode):** Dosyaları kaydettiğiniz an sunucuya göndermek yerine biriktirip tek tıkla onaylayarak canlıya push edebilirsiniz.
- **Güvenlik:** Şifreleriniz veya SSH anahtarlarınız `settings.json` dosyasına yazılmaz; doğrudan işletim sisteminizin güvenli anahtarlığında (`VS Code SecretStorage`) saklanır.

## 🛠 Mimari & Çalışma Mantığı

```
VS Code Explorer ──> RemoteFileSystemProvider ──> Smart Stat Cache ──> SftpClient ──> ConnectionManager (SSH2) ──> Remote Server
```

1. **Connection Manager:** SSH2 bağlantısını ve yeniden bağlanma (exponential backoff) mantığını yönetir.
2. **Channel Deduplication:** Onlarca dosya isteği aynı anda gelse bile SSH kanal kilitlenmesini engellemek için SFTP alt sistemini tekil olarak paylaşır.
3. **Connection Gate:** VS Code ilk açıldığında arka plan sorgularının sunucu bağlantısı tamamlanana kadar beklemesini sağlar.

## 🚀 Hızlı Başlangıç (Geliştirme)

1. Repoyu klonlayın ve bağımlılıkları yükleyin:
   ```bash
   git clone git@github.com:FerhatAkkopru/RemoteForge.git
   cd RemoteForge
   npm install
   ```

2. Projeyi derleyin:
   ```bash
   node ./node_modules/.bin/tsc
   node esbuild.js
   ```

3. VS Code'da projeyi açıp **`F5`** tuşuna basarak eklentiyi çalıştırın.

## 📖 Kullanım Kılavuzu

1. **Profil Ekleme:** `Cmd+Shift+P` (macOS) / `Ctrl+Shift+P` (Windows/Linux) basın ve **`RemoteForge: Add Server Profile`** komutunu seçin. Sunucu IP, port, kullanıcı adı ve şifre/key bilgilerinizi girin.
2. **Sunucuya Bağlanma:** **`RemoteForge: Connect to Server`** komutunu çalıştırın, eklediğiniz profili seçin ve açmak istediğiniz uzak dizini (örneğin `/` veya `/var/www`) girin.
3. **Logları İzleme:** Bağlantı ve dosya transfer detaylarını canlı izlemek için **`RemoteForge: Show Log`** komutunu kullanabilirsiniz.

## ⌨️ Komut Listesi

| Komut | Açıklama |
| :--- | :--- |
| `RemoteForge: Connect to Server` | Kayıtlı bir sunucuya bağlanır ve uzak dizini workspace olarak açar. |
| `RemoteForge: Disconnect` | Aktif sunucu bağlantısını ve uzak klasörü kapatır. |
| `RemoteForge: Add Server Profile` | Yeni sunucu bağlantı profili oluşturur. |
| `RemoteForge: Delete Server Profile` | Kayıtlı profili ve şifreleri sistemden siler. |
| `RemoteForge: Push Pending Changes` | Manuel senkronizasyon modunda bekleyen değişiklikleri sunucuya atar. |
| `RemoteForge: Show Log` | Detaylı işlem ve hata log panelini açar. |

---

## 📄 License / Lisans

MIT
