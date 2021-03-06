import { State } from '../BuildScript';
import { Language, BuildType } from '../types';
import type { Addon, BindingDefinition, PlatformSelection } from '../types';
import { generateDependencies, getVersion, isNativeApplicableToAllPlatforms } from './script';
import { versionNum } from '../reducer';

export function generateGradle({
  build,
  version,
  hardcoded,
  osgi,
  language,
  artifacts,
  platform,
  platformSingle,
  selected,
  addons,
  selectedAddons,
}: State) {
  const versionString = getVersion(version, build);
  const hasBoM = 323 <= versionNum(version);

  let script = platformSingle === null ? 'import org.gradle.internal.os.OperatingSystem\n\n' : '';

  if (!hardcoded) {
    if (language === Language.Groovy) {
      script += `project.ext.lwjglVersion = "${versionString}"`;
      selectedAddons.forEach((id: Addon) => {
        script += `\nproject.ext.${id}Version = "${addons[id].maven.version}"`;
      });
      if (platformSingle !== null) {
        script += `\nproject.ext.lwjglNatives = "natives-${platformSingle}"`;
      }
    } else {
      script += `val lwjglVersion = "${versionString}"`;
      selectedAddons.forEach((id: Addon) => {
        const v = id.indexOf('-') === -1 ? `${id}Version` : `\`${id}Version\``;
        script += `\nval ${v} = "${addons[id].maven.version}"`;
      });
      if (platformSingle !== null) {
        script += `\nval lwjglNatives = "natives-${platformSingle}"`;
      }
    }

    script += '\n\n';
  }
  if (platformSingle === null) {
    const linuxArches = +platform.linux + +platform['linux-arm64'] + +platform['linux-arm32'];
    const windowsArches = +platform.windows + +platform['windows-x86'];
    if (language === Language.Groovy) {
      script += `switch (OperatingSystem.current()) {`;
      if (linuxArches != 0) {
        script +=
          linuxArches == 1
            ? `
\tcase OperatingSystem.LINUX:
\t\tproject.ext.lwjglNatives = "natives-linux${platform.linux ? '' : platform['linux-arm64'] ? '-arm64' : '-arm32'}"
\t\tbreak`
            : `
\tcase OperatingSystem.LINUX:
\t\tdef osArch = System.getProperty("os.arch")
\t\tproject.ext.lwjglNatives = osArch.startsWith("arm") || osArch.startsWith("aarch64")
\t\t\t? "natives-linux-\${osArch.contains("64") || osArch.startsWith("armv8") ? "arm64" : "arm32"}"
\t\t\t: "natives-linux"
\t\tbreak`;
      }
      if (platform.macos) {
        script += `
\tcase OperatingSystem.MAC_OS:
\t\tproject.ext.lwjglNatives = "natives-macos"
\t\tbreak`;
      }
      if (windowsArches != 0) {
        script += `
\tcase OperatingSystem.WINDOWS:
\t\tproject.ext.lwjglNatives = ${
          windowsArches == 1
            ? `"natives-windows${platform.windows ? '' : '-x86'}"`
            : `System.getProperty("os.arch").contains("64") ? "natives-windows" : "natives-windows-x86"`
        }
\t\tbreak`;
      }
      script += `
}\n\n`;
    } else {
      script += `val lwjglNatives = when (OperatingSystem.current()) {`;
      if (linuxArches != 0) {
        script +=
          linuxArches == 1
            ? `\n\tOperatingSystem.LINUX   -> "natives-linux${
                platform.linux ? '' : platform['linux-arm64'] ? '-arm64' : '-arm32'
              }"`
            : `\n\tOperatingSystem.LINUX   -> System.getProperty("os.arch").let {
\t\tif (it.startsWith("arm") || it.startsWith("aarch64"))
\t\t\t"natives-linux-\${if (it.contains("64") || it.startsWith("armv8")) "arm64" else "arm32"}"
\t\telse
\t\t\t"natives-linux"
\t}`;
      }
      if (platform.macos) {
        script += `\n\tOperatingSystem.MAC_OS  -> "natives-macos"`;
      }
      if (windowsArches != 0) {
        script += `\n\tOperatingSystem.WINDOWS -> ${
          windowsArches == 1
            ? `"natives-windows${platform.windows ? '' : '-x86'}"`
            : `if (System.getProperty("os.arch").contains("64")) "natives-windows" else "natives-windows-x86"`
        }`;
      }
      script += `
\telse -> throw Error("Unrecognized or unsupported Operating system. Please set \\"lwjglNatives\\" manually")
}\n\n`;
    }
  }

  script += `repositories {
\tmavenCentral()`;
  if (build !== BuildType.Release) {
    if (language === Language.Groovy) {
      script += `\n\tmaven { url "https://oss.sonatype.org/content/repositories/snapshots/" }`;
    } else {
      script += `\n\tmaven("https://oss.sonatype.org/content/repositories/snapshots/")`;
    }
  }
  script += `
}

dependencies {`;

  if (language === Language.Groovy) {
    const v = hardcoded ? versionString : '$lwjglVersion';
    const classifier = !hardcoded || platformSingle == null ? '$lwjglNatives' : `natives-${platformSingle}`;
    if (hasBoM) {
      script += `
\timplementation platform("org.lwjgl:lwjgl-bom:${v}")
`;
    }
    script += generateDependencies(
      selected,
      artifacts,
      platform,
      osgi,
      (artifact, groupId, artifactId, hasEnabledNativePlatform) =>
        `\n\timplementation "${groupId}:${artifactId}${hasBoM ? '' : `:${v}`}"`,
      (artifact, groupId, artifactId) =>
        `\n\t${guardNative(artifact, platform)}runtimeOnly "${groupId}:${artifactId}:${
          hasBoM ? '' : `${v}`
        }:${classifier}"`
    );

    selectedAddons.forEach((id: Addon) => {
      const {
        maven: { groupId, artifactId, version },
      } = addons[id];
      script += `\n\timplementation "${groupId}:${artifactId}:${hardcoded ? version : `\${${id}Version}`}"`;
    });
  } else {
    const v = hasBoM ? '' : `, ${hardcoded ? `"${versionString}"` : 'lwjglVersion'}`;
    const classifier = !hardcoded || platformSingle == null ? 'lwjglNatives' : `"natives-${platformSingle}"`;
    if (hasBoM) {
      script += `
\timplementation(platform("org.lwjgl:lwjgl-bom:${hardcoded ? versionString : '$lwjglVersion'}"))
`;
    }
    script += generateDependencies(
      selected,
      artifacts,
      platform,
      osgi,
      (artifact, groupId, artifactId, hasEnabledNativePlatform) =>
        `\n\timplementation("${groupId}", "${artifactId}"${v})`,
      (artifact, groupId, artifactId) =>
        `\n\t${guardNative(
          artifact,
          platform
        )}runtimeOnly("${groupId}", "${artifactId}"${v}, classifier = ${classifier})`
    );

    selectedAddons.forEach((id: Addon) => {
      const {
        maven: { groupId, artifactId, version },
      } = addons[id];
      const v = id.indexOf('-') === -1 ? `${id}Version` : `\`${id}Version\``;
      script += `\n\timplementation("${groupId}", "${artifactId}", ${hardcoded ? `"${version}"` : v})`;
    });
  }

  script += `\n}`;

  return script;
}

function guardNative(artifact: BindingDefinition, platform: PlatformSelection) {
  return artifact.natives === undefined || isNativeApplicableToAllPlatforms(artifact, platform)
    ? ''
    : `if (${artifact.natives
        .filter((p) => platform[p])
        .map((p) => `lwjglNatives == "natives-${p}"`)
        .join(' || ')}) `;
}
