import Markdown from 'react-native-markdown-display';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { TypoClient, type Note, type NoteSession } from '@typo/client';
const apiUrl = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const client = new TypoClient(apiUrl);
export default function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const { id } = useLocalSearchParams<{ id?: string }>();
  const note = notes.find((n) => n.id === id) || null;
  const [title, setTitle] = useState<string | undefined>();
  const [content, setContent] = useState('');
  const [status, setStatus] = useState('connecting');
  const [preview, setPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const session = useRef<NoteSession | null>(null);
  async function load() {
    setLoading(true);
    try {
      setNotes(await client.list());
    } catch (e) {
      Alert.alert(
        '连接失败',
        `${String(e)}\nAPI: ${apiUrl}\n真机请配置 EXPO_PUBLIC_API_URL 为电脑的局域网 IP。`,
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let cancelled = false;
    void client
      .list()
      .then((data) => {
        if (!cancelled) setNotes(data);
      })
      .catch((e) => {
        if (!cancelled) Alert.alert('连接失败', String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!id) return;
    const active = client.connect(id);
    session.current = active;
    const update = () => {
      setContent(active.text.toString());
      setStatus(active.status);
    };
    const unsubscribe = active.subscribe(update);
    return () => {
      unsubscribe();
      active.destroy();
      session.current = null;
    };
  }, [id]);
  async function create() {
    try {
      const created = await client.create();
      setNotes((prev) => [created, ...prev]);
      router.push({ pathname: '/note/[id]', params: { id: created.id } });
    } catch (e) {
      Alert.alert('创建失败', String(e));
    }
  }
  async function rename() {
    if (!note || title === undefined || title === note.title) return;
    try {
      const updated = await client.rename(note.id, title);
      setTitle(updated.title);
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    } catch (e) {
      Alert.alert('保存失败', String(e));
    }
  }
  async function back() {
    await rename();
    router.replace('/');
    void load();
  }
  function remove() {
    if (!note) return;
    Alert.alert('删除文档', '删除后无法恢复，是否继续？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void client
            .delete(note.id)
            .then(() => {
              router.replace('/');
              void load();
            })
            .catch((e) => Alert.alert('删除失败', String(e)));
        },
      },
    ]);
  }
  if (id && !note)
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <Pressable onPress={() => router.replace('/')}>
            <Text style={s.brand}>‹ 文档列表</Text>
          </Pressable>
        </View>
        <Text style={s.subtitle}>
          {loading ? '正在加载文档…' : '文档不存在或连接失败，请返回列表重试。'}
        </Text>
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={s.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.header}>
          <Pressable
            onPress={() => {
              if (note) void back();
            }}
          >
            <Text style={s.brand}>{note ? '‹ 文档列表' : 'typo.'}</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              if (note)
                void Share.share({
                  message: content,
                  title: title ?? note.title,
                });
              else void create();
            }}
          >
            <Text style={s.action}>{note ? '导出内容' : '＋ 新建'}</Text>
          </Pressable>
        </View>
        {note ? (
          <>
            <TextInput
              style={s.title}
              accessibilityLabel="文档标题"
              value={title ?? note.title}
              maxLength={160}
              onChangeText={setTitle}
              onBlur={() => void rename()}
            />
            <View style={s.row}>
              <Text style={s.meta}>
                {status === 'connected'
                  ? '● 实时同步已连接'
                  : status === 'deleted'
                    ? '文档已删除'
                    : status === 'offline'
                      ? '离线 · 保持页面打开等待重连'
                      : status === 'error'
                        ? '同步失败，请导出备份'
                        : '正在连接…'}
              </Text>
              <Pressable onPress={() => setPreview((value) => !value)}>
                <Text style={s.action}>{preview ? '编辑' : '预览'}</Text>
              </Pressable>
              <Pressable onPress={remove}>
                <Text style={s.delete}>删除</Text>
              </Pressable>
            </View>
            <ScrollView style={s.editor} keyboardShouldPersistTaps="handled">
              <View style={{ padding: preview ? 24 : 0 }}>
                {preview ? (
                  <Markdown
                    style={{
                      body: { color: '#4d6045', fontSize: 15, lineHeight: 26 },
                    }}
                  >
                    {content}
                  </Markdown>
                ) : (
                  <TextInput
                    multiline
                    textAlignVertical="top"
                    style={s.input}
                    accessibilityLabel="Markdown 编辑器"
                    value={content}
                    editable={status === 'connected' || status === 'offline'}
                    onChangeText={(value) => session.current?.replace(value)}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="开始写作…"
                  />
                )}
              </View>
            </ScrollView>
            <Text style={s.footer}>
              MARKDOWN · {content.length} 字符 · 离线修改仅保存在内存
            </Text>
          </>
        ) : (
          <>
            <Text style={s.subtitle}>为每一个灵感留一页。</Text>
            <FlatList
              data={notes}
              keyExtractor={(item) => item.id}
              refreshing={loading}
              onRefresh={() => void load()}
              contentContainerStyle={{ padding: 20 }}
              ListEmptyComponent={
                <Text style={s.meta}>还没有文档，下拉刷新或新建一篇。</Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={s.card}
                  onPress={() =>
                    router.push({
                      pathname: '/note/[id]',
                      params: { id: item.id },
                    })
                  }
                >
                  <Text style={s.cardTitle}>▤ {item.title}</Text>
                  <Text style={s.meta}>
                    {new Date(item.updatedAt).toLocaleString()}
                  </Text>
                </Pressable>
              )}
            />
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fafbf8' },
  header: {
    padding: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: '#e1e7dc',
  },
  brand: { fontSize: 24, fontWeight: '700', color: '#3e624b' },
  action: { color: '#3e624b', fontSize: 16 },
  subtitle: { padding: 24, color: '#7b876e', fontSize: 16 },
  card: {
    padding: 20,
    backgroundColor: '#edf2e7',
    borderRadius: 12,
    marginBottom: 12,
    gap: 10,
  },
  cardTitle: { fontSize: 17, color: '#344b33', fontWeight: '600' },
  meta: { fontSize: 11, color: '#7c8b72' },
  title: { fontSize: 27, fontWeight: '600', padding: 24, color: '#30452e' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  delete: { color: '#a06a58', fontSize: 12 },
  editor: { flex: 1, borderTopWidth: 1, borderColor: '#e1e7dc' },
  input: {
    padding: 24,
    fontSize: 15,
    lineHeight: 26,
    color: '#4d6045',
    minHeight: 400,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  footer: { padding: 12, fontSize: 10, color: '#8b957f', textAlign: 'center' },
});
