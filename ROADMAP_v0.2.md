# RemoteForge — İyileştirme Planı (v0.2 Yol Haritası)

> Bu yol haritası, projenin mevcut v0.1.0 sürümü üzerindeki mimari ve güvenlik analizleri sonucunda tespit edilen eksikliklerin önceliklendirilerek uygulanabilir bir plana dönüştürülmüş halidir.

---

## 🎯 Öncelik Sıralaması İlkesi
**Önce veriyi ve çökme risklerini engelle ➔ Sonra test güvencesi sağla ➔ Sonra manuel dünya senaryolarını doğrula ➔ Sonra UX geliştirmeleri ve Marketplace yayını.**

---

## 🚨 Faz A — Kritik Sağlamlaştırma (Riski Yüksek)

- [x] **A1. Büyük Dosya Akışı ve Boyut Kontrolü (OOM Koruması):** `readFile` öncesi 50MB sınır kontrolü ve onay diyaloğu eklendi (`remoteFileSystemProvider.ts`).
- [x] **A2. `hostVerifier` Parmak İzi Etiketi Düzeltmesi:** TOFU diyalogunda SHA256 parmak izi etiketi netleştirildi (`hostKeyStore.ts`).

---

## 🧪 Faz B — Test Kapsamını Genişletme (Regresyon Önleme)

- [x] **B1. `SyncEngine` Testleri:** Otomatik/manuel mod ve kuyruk boşaltma birim testleri (`test/syncEngine.test.ts`).
- [x] **B2. `SftpClient` Cache & Invalidation Testleri:** Child stat pre-population ve kopma durumunda cache temizliği (`test/sftpClientCache.test.ts`).
- [x] **B3. `ConnectionManager` Reconnect Testleri:** Üstel geri çekilme (`exponential backoff`) hesaplama testi (`test/connectionManager.test.ts`).

**Sonuç:** Birim test sayısı 4'ten 11'e yükseltildi (4 suite, %100 başarı).

---

## 🎨 Faz D — Kullanıcı Deneyimi (UX) İyileştirmeleri

- [x] **D1. Çakışma Diff Gösterimi:** Çakışma durumunda `Compare Differences` ile `vscode.diff` başlatma yeteneği (`conflictDetector.ts`).
- [x] **D2. `FileDecorationProvider` Entegrasyonu:** Manuel senkronizasyon modunda bekleyen dosyaları Explorer ağacında 'M' rozeti ile gösterme (`fileDecoration.ts`).
- [ ] **D3. Remote Grep (`TextSearchProvider`):** Uzak sunucuda arama yeteneği (İleri Seviye).

---

## 🚀 Faz E — Yayın ve Büyüme

- [ ] **E1. VS Code Marketplace Yayını:** `vsce publish` ile resmi mağazada yayınlama.
- [ ] **E2. Demo Ekran Kaydı (GIF/Video):** README içerisine eklentinin canlı çalışma ve çakışma çözme videosunu ekleme.
- [ ] **E3. Topluluk Geri Bildirimi:** İlk geliştirici kullanıcı grubundan GitHub Issues üzerinden geri bildirim toplama.
