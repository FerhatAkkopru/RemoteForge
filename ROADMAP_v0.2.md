# RemoteForge — İyileştirme Planı (v0.2 Yol Haritası)

> Bu yol haritası, projenin mevcut v0.1.0 sürümü üzerindeki mimari ve güvenlik analizleri sonucunda tespit edilen eksikliklerin önceliklendirilerek uygulanabilir bir plana dönüştürülmüş halidir.

---

## 🎯 Öncelik Sıralaması İlkesi
**Önce veriyi ve çökme risklerini engelle ➔ Sonra test güvencesi sağla ➔ Sonra manuel dünya senaryolarını doğrula ➔ Sonra UX geliştirmeleri ve Marketplace yayını.**

---

## 🚨 Faz A — Kritik Sağlamlaştırma (Riski Yüksek)

### A1. Büyük Dosya Akışı ve Boyut Kontrolü (OOM Koruması)
- **Problem:** `sftpClient.readFile()` tüm dosya verisini belleğe alır. 50MB-100MB üzeri dosyalar VS Code Extension Host sürecinin bellek sınırını aşarak eklentiyi çökertebilir.
- **Çözüm:** `readFile` öncesinde `stat()` yapılarak dosya boyutu kontrol edilir. 50MB üzerindeki dosyalar için kullanıcıya onay penceresi ("Bu dosya çok büyük, yine de açmak istiyor musunuz?") gösterilir.
- **Doğrulama:** Sunucuda `dd if=/dev/zero of=big.log bs=1M count=100` ile 100MB dosya oluşturulup test edilir.

### A2. `hostVerifier` Parmak İzi ve Etiket Düzeltmesi
- **Problem:** TOFU diyalogunda gösterilen `key.toString('hex').substring(0, 20)` etiketi "algoritma" olarak ifade ediliyordu.
- **Çözüm:** "Algoritma" etiketi yerine açıkça "Sunucu Parmak İzi (Fingerprint Prefix)" ifadesi kullanılır veya sunucu el sıkışma algoritması açıkça elde edilir.
- **Doğrulama:** TOFU uyarısındaki metin etiketi doğrulanır.

---

## 🧪 Faz B — Test Kapsamını Genişletme (Regresyon Önleme)

- [ ] **B1. `SyncEngine` Testleri:** Otomatik ve manuel senkronizasyon modları, `pushAllChanges()` kuyruk yönetimi.
- [ ] **B2. `SftpClient` Cache & Invalidation Testleri:** TTL süresi (30 sn) simülasyonu, `invalidatePath()` ile üst dizin temizliği.
- [ ] **B3. `ConnectionManager` Reconnect Testleri:** Üstel geri çekilme (`exponential backoff`) ve max deneme sınırının kontrolü.

**Hedef:** Birim test sayısını 4'ten 20+'ye çıkararak regresyon riskini sıfırlamak.

---

## 📋 Faz C — Gerçek Dünya Manuel Doğrulama Checklist

- [ ] **Performans:** 500+ dosyalı, 5+ seviye derinlikli uzak dizinde gezinme hızı.
- [ ] **Ağ Kesintisi:** Yavaş / kopan ağlarda üstel geri çekilme (`reconnect`) mekanizması.
- [ ] **Çoklu Düzenleme:** Aynı dosyayı iki farklı oturumda değiştirip çakışma uyarısını görme.
- [ ] **Kalıcılık:** VS Code kapatılıp açıldığında oturumun otomatik bağlanabilmesi (`auto-reconnect`).

---

## 🎨 Faz D — Kullanıcı Deneyimi (UX) İyileştirmeleri

- [ ] **D1. Çakışma Diff Gösterimi:** Çakışma durumunda `vscode.diff` ile yerel ve uzak içerikleri yan yana kıyaslama imkanı.
- [ ] **D2. `FileDecorationProvider` Entegrasyonu:** Manuel senkronizasyon modunda bekleyen dosyaları Explorer ağacında görsel olarak işaretleme.
- [ ] **D3. Remote Grep (`TextSearchProvider`):** Uzak sunucuda arama yeteneği (İleri Seviye).

---

## 🚀 Faz E — Yayın ve Büyüme

- [ ] **E1. VS Code Marketplace Yayını:** `vsce publish` ile resmi mağazada yayınlama.
- [ ] **E2. Demo Ekran Kaydı (GIF/Video):** README içerisine eklentinin canlı çalışma ve çakışma çözme videosunu ekleme.
- [ ] **E3. Topluluk Geri Bildirimi:** İlk geliştirici kullanıcı grubundan GitHub Issues üzerinden geri bildirim toplama.
