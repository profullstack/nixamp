plugins {
    id("com.android.application")
}

val releaseKeystorePath = providers.environmentVariable("BACKTOSCHOOL_KEYSTORE_PATH").orNull

android {
    namespace = "help.backtoschool.tv"
    compileSdk = 36

    defaultConfig {
        applicationId = "help.backtoschool.tv"
        minSdk = 22
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (!releaseKeystorePath.isNullOrBlank()) {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = providers.environmentVariable("BACKTOSCHOOL_KEYSTORE_PASSWORD").get()
                keyAlias = providers.environmentVariable("BACKTOSCHOOL_KEY_ALIAS").getOrElse("backtoschool")
                keyPassword = providers.environmentVariable("BACKTOSCHOOL_KEY_PASSWORD").get()
                storeType = "PKCS12"
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}
