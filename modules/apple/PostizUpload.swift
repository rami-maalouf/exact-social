import Foundation

private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class PostizUpload: ExactModule {
    override func later(_ request: [String: Any], reply: ExactReply) {
        guard request["op"] as? String == "upload",
              let path = request["path"] as? String,
              let url = URL(string: request["url"] as? String ?? ""),
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "") && url.port == 4786),
              url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.hasSuffix("/api/public/v1/upload"),
              let key = request["key"] as? String, !key.contains("\r"), !key.contains("\n"),
              let name = request["name"] as? String, name.range(of: #"^[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil,
              let type = request["type"] as? String, ["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4"].contains(type),
              let size = request["size"] as? Int, size > 0, size <= 2 * 1024 * 1024 * 1024 else {
            return reply.fail("invalid upload")
        }
        let roots = [("app:/data/media/", context.data.appendingPathComponent("media")),
                     ("app:/tmp/picked/", context.temporary.appendingPathComponent("picked"))]
        guard let (prefix, root) = roots.first(where: { path.hasPrefix($0.0) }) else { return reply.fail("invalid attachment path") }
        let source = root.appendingPathComponent(String(path.dropFirst(prefix.count))).standardizedFileURL.resolvingSymlinksInPath()
        guard source.path.hasPrefix(root.deletingLastPathComponent().resolvingSymlinksInPath().appendingPathComponent(root.lastPathComponent).path + "/") else { return reply.fail("invalid attachment path") }
        let temporary = context.temporary.appendingPathComponent(UUID().uuidString)
        Task {
            do {
                let boundary = UUID().uuidString
                try Self.stage(source, temporary, name, type, size, boundary)
                let configuration = URLSessionConfiguration.ephemeral
                configuration.timeoutIntervalForResource = 24 * 3600
                let session = URLSession(configuration: configuration, delegate: RejectRedirects(), delegateQueue: nil)
                defer { session.finishTasksAndInvalidate() }
                var send = URLRequest(url: url)
                send.httpMethod = "POST"
                send.setValue(key, forHTTPHeaderField: "Authorization")
                send.setValue("multipart/form-data; boundary=" + boundary, forHTTPHeaderField: "Content-Type")
                let (data, response) = try await session.upload(for: send, fromFile: temporary)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                try? FileManager.default.removeItem(at: temporary)
                reply.send(["status": status, "data": (try? JSONSerialization.jsonObject(with: data)) ?? NSNull()])
            } catch {
                try? FileManager.default.removeItem(at: temporary)
                reply.fail("could not read or transfer this attachment")
            }
        }
    }

    private static func stage(_ source: URL, _ temporary: URL, _ name: String, _ type: String, _ size: Int, _ boundary: String) throws {
        let header = "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: \(type)\r\n\r\n"
        try Data(header.utf8).write(to: temporary, options: .withoutOverwriting)
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let output = try FileHandle(forWritingTo: temporary)
        defer { try? output.close() }
        try output.seekToEnd()
        var count = 0
        while let bytes = try autoreleasepool(invoking: { try input.read(upToCount: 1024 * 1024) }), !bytes.isEmpty {
            count += bytes.count
            guard count <= size else { throw ExactNativeRefusal("attachment changed") }
            try output.write(contentsOf: bytes)
        }
        guard count == size else { throw ExactNativeRefusal("attachment changed") }
        try output.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
    }
}

let exactModule: ExactModule.Type = PostizUpload.self
