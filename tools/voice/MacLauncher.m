#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>

// Request permission as the local launcher application; never alter macOS privacy databases.
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSBundle *bundle = NSBundle.mainBundle;
        NSString *home = [bundle.resourcePath stringByAppendingPathComponent:@"Java/Contents/Home"];
        NSString *java = [home stringByAppendingPathComponent:@"bin/java"];
        NSString *jar = [bundle.resourcePath stringByAppendingPathComponent:@"TLauncher.jar"];
        BOOL valid = [bundle.bundleIdentifier isEqualToString:@"local.tlauncher.launcher"] &&
            [[bundle objectForInfoDictionaryKey:@"NSMicrophoneUsageDescription"] length] > 0 &&
            [NSFileManager.defaultManager isExecutableFileAtPath:java] &&
            [NSFileManager.defaultManager fileExistsAtPath:jar];
        if (argc == 2 && strcmp(argv[1], "--check") == 0) {
            puts(valid ? "launcher_metadata_valid" : "launcher_metadata_invalid");
            return valid ? 0 : 1;
        }
        if (!valid) return 1;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        void (^launch)(void) = ^{
            NSTask *task = [[NSTask alloc] init];
            task.executableURL = [NSURL fileURLWithPath:java];
            task.arguments = @[@"-Xdock:name=TLauncher", @"-jar", jar];
            NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
            environment[@"JAVA_HOME"] = home;
            task.environment = environment;
            task.terminationHandler = ^(NSTask *completed) {
                dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
            };
            NSError *error;
            if (![task launchAndReturnError:&error]) {
                NSAlert *alert = [[NSAlert alloc] init];
                alert.messageText = @"TLauncher could not start";
                alert.informativeText = error.localizedDescription;
                [alert runModal]; [NSApp terminate:nil];
            }
        };
        dispatch_async(dispatch_get_main_queue(), ^{
            [NSApp activateIgnoringOtherApps:YES];
            if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] == AVAuthorizationStatusNotDetermined) {
                [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
                    dispatch_async(dispatch_get_main_queue(), launch);
                }];
            } else { launch(); }
        });
        [NSApp run];
    }
    return 0;
}
