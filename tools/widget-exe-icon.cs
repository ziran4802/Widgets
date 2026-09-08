using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class WidgetExecutableIcon
{
    private const int RtIcon = 3;
    private const int RtGroupIcon = 14;
    private const uint LoadLibraryAsDatafile = 0x00000002;
    private const ushort NeutralLanguage = 0;

    [UnmanagedFunctionPointer(CallingConvention.Winapi, CharSet = CharSet.Unicode)]
    private delegate bool EnumResourceNamesProc(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);

    [UnmanagedFunctionPointer(CallingConvention.Winapi, CharSet = CharSet.Unicode)]
    private delegate bool EnumResourceLanguagesProc(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr parameter);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr BeginUpdateResource(string fileName, bool deleteExistingResources);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResource(IntPtr update, bool discard);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string fileName, IntPtr file, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EnumResourceNames(IntPtr module, IntPtr type, EnumResourceNamesProc callback, IntPtr parameter);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool EnumResourceLanguages(IntPtr module, IntPtr type, IntPtr name, EnumResourceLanguagesProc callback, IntPtr parameter);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr module);

    public static void Apply(string executablePath, byte[] icoBytes)
    {
        var images = ReadImages(icoBytes);
        var group = ReadGroup(icoBytes, images);
        var groupNames = ReadGroupNames(executablePath);
        if (groupNames.Count == 0) groupNames.Add(new ResourceName(1));
        var languages = new HashSet<ushort> { NeutralLanguage };
        foreach (var groupName in groupNames)
        {
            foreach (var language in groupName.Languages) languages.Add(language);
        }

        var update = BeginUpdateResource(executablePath, false);
        if (update == IntPtr.Zero) throw LastError("BeginUpdateResource");
        var discard = true;
        try
        {
            for (var index = 0; index < images.Count; index++)
            {
                foreach (var language in languages) Update(update, RtIcon, new ResourceName(index + 1), language, images[index]);
            }
            foreach (var groupName in groupNames)
            {
                foreach (var language in groupName.Languages) Update(update, RtGroupIcon, groupName, language, group);
            }
            discard = false;
        }
        finally
        {
            if (!EndUpdateResource(update, discard) && !discard) throw LastError("EndUpdateResource");
        }
    }

    private static List<byte[]> ReadImages(byte[] ico)
    {
        if (ico == null || ico.Length < 6) throw new InvalidDataException("ICO header is missing");
        if (ReadUInt16(ico, 0) != 0 || ReadUInt16(ico, 2) != 1) throw new InvalidDataException("ICO header is invalid");
        var count = ReadUInt16(ico, 4);
        if (count == 0 || ico.Length < 6 + count * 16) throw new InvalidDataException("ICO entries are missing");
        var images = new List<byte[]>(count);
        for (var index = 0; index < count; index++)
        {
            var entry = 6 + index * 16;
            var size = ReadUInt32(ico, entry + 8);
            var offset = ReadUInt32(ico, entry + 12);
            if (size == 0 || offset > (uint)ico.Length || size > (uint)ico.Length - offset || size > int.MaxValue) throw new InvalidDataException("ICO image is outside the file");
            var image = new byte[(int)size];
            Buffer.BlockCopy(ico, (int)offset, image, 0, (int)size);
            images.Add(image);
        }
        return images;
    }

    private static byte[] ReadGroup(byte[] ico, List<byte[]> images)
    {
        var count = (ushort)images.Count;
        using (var stream = new MemoryStream(6 + count * 14))
        using (var writer = new BinaryWriter(stream))
        {
            writer.Write((ushort)0);
            writer.Write((ushort)1);
            writer.Write(count);
            for (var index = 0; index < count; index++)
            {
                var entry = 6 + index * 16;
                writer.Write(icoByte(ico, entry));
                writer.Write(icoByte(ico, entry + 1));
                writer.Write(icoByte(ico, entry + 2));
                writer.Write(icoByte(ico, entry + 3));
                writer.Write(ReadUInt16(ico, entry + 4));
                writer.Write(ReadUInt16(ico, entry + 6));
                writer.Write((uint)images[index].Length);
                writer.Write((ushort)(index + 1));
            }
            return stream.ToArray();
        }
    }

    private static List<ResourceName> ReadGroupNames(string executablePath)
    {
        var names = new List<ResourceName>();
        var module = LoadLibraryEx(executablePath, IntPtr.Zero, LoadLibraryAsDatafile);
        if (module == IntPtr.Zero) return names;
        try
        {
            EnumResourceNamesProc callback = (currentModule, type, name, parameter) =>
            {
                var resourceName = (name.ToInt64() >> 16) == 0
                    ? new ResourceName(name.ToInt32())
                    : new ResourceName(Marshal.PtrToStringUni(name));
                EnumResourceLanguagesProc languageCallback = (languageModule, languageType, languageName, language, languageParameter) =>
                {
                    resourceName.Languages.Add(language);
                    return true;
                };
                if (!EnumResourceLanguages(currentModule, type, name, languageCallback, IntPtr.Zero))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != 1813) throw new Win32Exception(error, "EnumResourceLanguages failed");
                }
                if (resourceName.Languages.Count == 0) resourceName.Languages.Add(NeutralLanguage);
                names.Add(resourceName);
                return true;
            };
            if (!EnumResourceNames(module, (IntPtr)RtGroupIcon, callback, IntPtr.Zero))
            {
                var error = Marshal.GetLastWin32Error();
                if (error != 1813) throw new Win32Exception(error, "EnumResourceNames failed");
            }
        }
        finally
        {
            FreeLibrary(module);
        }
        return names;
    }

    private static void Update(IntPtr update, int type, ResourceName name, ushort language, byte[] data)
    {
        var namePointer = name.Allocate();
        try
        {
            if (!UpdateResource(update, (IntPtr)type, namePointer, language, data, (uint)data.Length)) throw LastError("UpdateResource");
        }
        finally
        {
            name.Release(namePointer);
        }
    }

    private sealed class ResourceName
    {
        private readonly int? id;
        private readonly string text;
        public readonly List<ushort> Languages = new List<ushort>();

        public ResourceName(int value) { id = value; }
        public ResourceName(string value)
        {
            if (value == null) throw new InvalidDataException("resource name is missing");
            text = value;
        }

        public IntPtr Allocate()
        {
            return id.HasValue ? (IntPtr)id.Value : Marshal.StringToHGlobalUni(text);
        }

        public void Release(IntPtr value)
        {
            if (!id.HasValue) Marshal.FreeHGlobal(value);
        }
    }

    private static ushort ReadUInt16(byte[] value, int offset)
    {
        return (ushort)(value[offset] | (value[offset + 1] << 8));
    }

    private static uint ReadUInt32(byte[] value, int offset)
    {
        return (uint)(value[offset] | (value[offset + 1] << 8) | (value[offset + 2] << 16) | (value[offset + 3] << 24));
    }

    private static byte icoByte(byte[] value, int offset)
    {
        return value[offset];
    }

    private static Win32Exception LastError(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }
}
